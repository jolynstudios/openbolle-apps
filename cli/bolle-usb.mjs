// Je eigen Bolle via USB, voor `dev`: dezelfde code in de browser (Web Serial) en in Node (`dev --bolle`).
// Bolle moet in de debugstand staan (Menu -> Systeem -> Debug, of de opdracht DEBUG 1). Het protocol staat in BolleOS
// (plugins_usb.c): de app, zijn tegel, meldingen en antwoorden gaan als JSON in delen van 72 bytes (base64),
// want een regel naar Bolle is hooguit 127 tekens. Bolle vraagt zelf om een nieuwe tegel ("DEV VRAAG BLOK <id>").
// Meekijken: "SHOTK <n>" geeft het huidige scherm n keer kleiner, in dezelfde regels als SHOT.

const DEEL = 72;                       // bytes per DEV DEEL (base64: 96 tekens)
const MAX_JSON = 2048;                 // zo groot mag een JSON-bericht op Bolle zijn

const naarB64 = (bytes) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };

/** Kort een tekst in tot hooguit n tekens (niet midden in een teken; Bolle heeft vaste buffers in bytes). */
export function kort(t, n) {
  const s = String(t ?? "");
  if (new TextEncoder().encode(s).length <= n) return s;
  let uit = "";
  for (const c of s) { if (new TextEncoder().encode(uit + c + "…").length > n) break; uit += c; }
  return uit + "…";
}

export class BolleUsb {
  /** schrijf(regel): stuurt één regel (zonder \n) naar Bolle. log(soort, regel): optioneel. */
  constructor(schrijf, { log = () => {} } = {}) {
    this.schrijf = schrijf;
    this.log = log;
    this.rij = Promise.resolve();      // alles wat een antwoord verwacht gaat één voor één
    this.wacht = null;                 // { soort: "dev"|"shot", klaar, mis, timer }
    this.shot = null;
    this.op = {};
    this.debug = null;
    this.plugin = null;
    this.versie = "";
  }
  on(naam, f) { this.op[naam] = f; return this; }

  /** Elke regel die van Bolle binnenkomt (zonder \n). */
  regel(r) {
    r = r.replace(/\r$/, "");
    if (r.startsWith("SHOT:")) return this.#shotRegel(r);
    if (r.startsWith("DEV VRAAG ")) { this.log("bolle", r); this.op.vraag?.(r.slice(10)); return; }
    if (r.startsWith("DEV ACTIE ")) {                 // op Bolle getikt: "DEV ACTIE <actie|-> <antwoord> <blok|->"
      const [actie, antwoord, blok] = r.slice(10).split(" ").map((x) => (x === "-" ? "" : x));
      this.log("bolle", r); this.op.actie?.({ actie, antwoord, blok }); return;
    }
    if (r === "DEV UIT") { this.plugin = null; this.log("bolle", r); this.op.uit?.(); return; }
    const m = /^DEV debug=(\d) plugin=(\S+)/.exec(r);
    if (m) { this.debug = m[1] === "1"; this.plugin = m[2] === "-" ? null : m[2]; }
    if (r.startsWith("INFO ")) { const v = /versie=(\S+)/.exec(r); if (v) this.versie = v[1]; }
    if (r.startsWith("DEV ") && this.wacht?.soort === "dev") { const w = this.wacht; this.wacht = null; clearTimeout(w.timer); w.klaar(r); }
    if (/^(DEV|INFO|PLUGIN|APP |PROFIEL|E \(|W \()/.test(r)) this.log("bolle", r);
  }

  #shotRegel(r) {
    const w = this.wacht;
    if (!w || w.soort !== "shot") return;
    if (r.startsWith("SHOT:BEGIN")) { const [, b, h, st] = r.split(" ").map(Number); this.shot = { b, h, st, delen: [] }; return; }
    if (r === "SHOT:FAIL") { this.wacht = null; clearTimeout(w.timer); w.mis(new Error("Bolle kon geen foto maken")); return; }
    if (r === "SHOT:END") {
      this.wacht = null; clearTimeout(w.timer);
      const x = this.shot; this.shot = null;
      if (!x) return w.mis(new Error("foto zonder begin"));
      const n = x.st * x.h, data = new Uint8Array(n);
      x.delen.forEach((d, i) => {                    // een kapotte regel wordt een zwarte streep, geen fout
        try { const s = atob(d); for (let k = 0; k < s.length && i * 768 + k < n; k++) data[i * 768 + k] = s.charCodeAt(k); } catch { /* overslaan */ }
      });
      const rgba = new Uint8ClampedArray(x.b * x.h * 4);
      for (let y = 0; y < x.h; y++) for (let p = 0; p < x.b; p++) {
        const o = y * x.st + p * 2, v = data[o] | (data[o + 1] << 8), q = (y * x.b + p) * 4;
        rgba[q] = (v >> 11) << 3; rgba[q + 1] = ((v >> 5) & 63) << 2; rgba[q + 2] = (v & 31) << 3; rgba[q + 3] = 255;
      }
      return w.klaar({ breed: x.b, hoog: x.h, rgba });
    }
    this.shot?.delen.push(r.slice(5));
  }

  #inRij(f) { const p = this.rij.then(f, f); this.rij = p.catch(() => {}); return p; }
  #verwacht(soort, regel, ms) {
    return new Promise((klaar, mis) => {
      const timer = setTimeout(() => { this.wacht = null; mis(new Error(`Bolle antwoordt niet op "${regel.slice(0, 20)}"`)); }, ms);
      this.wacht = { soort, klaar, mis, timer };
      this.schrijf(regel);
    });
  }

  /** Een losse opdracht zonder antwoord (TAP, UI ..., DEBUG 1), netjes tussen de rest door. */
  opdracht(regel) { return this.#inRij(async () => { this.log("naar bolle", regel); this.schrijf(regel); }); }

  /** Stand: { debug, plugin }. */
  stand() {
    return this.#inRij(async () => {
      this.schrijf("INFO");
      const r = await this.#verwacht("dev", "DEV", 3000);
      if (!r.startsWith("DEV debug=")) throw new Error("Deze Bolle kent DEV nog niet: werk BolleOS bij (1.1.0 of nieuwer).");
      return { debug: this.debug, plugin: this.plugin, versie: this.versie };
    });
  }

  /** JSON in delen naar Bolle. soort: plugin | blok | melding | antwoord. */
  stuurJson(soort, obj) {
    return this.#inRij(async () => {
      const data = new TextEncoder().encode(JSON.stringify(obj));
      if (data.length > MAX_JSON) throw new Error(`${soort} is te groot voor Bolle (${data.length} van ${MAX_JSON} bytes)`);
      this.log("naar bolle", `${soort} ${JSON.stringify(obj)}`);
      let r = await this.#verwacht("dev", `DEV BEGIN ${soort} ${data.length}`, 3000);
      for (let i = 0; i < data.length && r === "DEV ok"; i += DEEL) r = await this.#verwacht("dev", "DEV DEEL " + naarB64(data.slice(i, i + DEEL)), 3000);
      if (r === "DEV ok") r = await this.#verwacht("dev", "DEV EINDE", 4000);
      if (!r.startsWith("DEV klaar")) throw new Error(r.replace(/^DEV (fout )?/, ""));
      if (soort === "plugin") this.plugin = obj.id;
    });
  }

  /** Het huidige scherm, n keer kleiner (2 = 233 px, ~2,5 s; 1 = ware grootte, ~9 s). { breed, hoog, rgba } */
  scherm(n = 2) { return this.#inRij(() => this.#verwacht("shot", n === 1 ? "SHOT -2" : `SHOTK ${n}`, 30000)); }

  /** Tik op het scherm van Bolle (x, y in pixels van het echte scherm, 466 x 466). */
  tik(x, y) { return this.opdracht(`TAP ${Math.round(x)} ${Math.round(y)}`); }
  uit() { return this.opdracht("DEV UIT"); }
}

/* ---------- de app uit app.yaml op Bolle zetten (het woord "plugin" in het USB-protocol is dat van BolleOS) ---------- */

/** Het hoofdblok, zoals de broker het kiest: het blok met hoofdscherm: true, anders het eerste. Alleen dat toont Bolle. */
export function hoofdblok(m) {
  const bl = m?.blokken ?? [];
  return bl.find((b) => b.hoofdscherm) ?? bl[0] ?? null;
}

/** Wat Bolle van de app toont in Menu -> Apps (net als in /v1/apps: het pictogram uit het manifest). */
export function appVoorBolle(m) {
  return { id: m.id, naam: kort(m.naam, 23), kort: kort(m.beschrijving?.kort ?? "In ontwikkeling", 47), pictogram: m.pictogram ?? hoofdblok(m)?.pictogram ?? "info" };
}

/** Een blok zoals dev het teruggeeft ({titel, waarde, regels, meter}) in de maten van Bolle. */
export function blokVoorBolle(b) {
  /* b is al ingekort zoals de broker dat doet (Apparaat.blok); hier alleen nog de grenzen van één bericht naar Bolle */
  const uit = JSON.parse(JSON.stringify(b ?? {}));
  uit.titel = kort(uit.titel, 27); uit.waarde = kort(uit.waarde, 27);
  uit.regels = (uit.regels ?? []).slice(0, 6).map((r) => kort(r, 123));
  if (Number.isFinite(uit.meter)) uit.meter = Math.max(0, Math.min(100, Math.round(uit.meter)));
  delete uit.melding;
  const groot = () => new TextEncoder().encode(JSON.stringify(uit)).length > MAX_JSON;
  /* te groot voor één bericht: eerst wat de assistent leest, dan kaarten van achteren, dan schermen van achteren */
  while (groot() && uit.regels.length) uit.regels.pop();
  const kaartLijsten = () => [uit, ...(uit.schermen ?? [])].filter((s) => (s.kaarten?.length ?? 0) > 1);
  while (groot() && kaartLijsten().length) kaartLijsten().at(-1).kaarten.pop();
  while (groot() && (uit.schermen?.length ?? 0) > 1) uit.schermen.pop();
  return uit;
}

/** Het antwoord van een tool zoals Bolle het in de berichten zet. */
export function antwoordVoorBolle(tekst) { return { tekst: kort(String(tekst ?? "").replace(/\s+/g, " ").trim(), 71) }; }
