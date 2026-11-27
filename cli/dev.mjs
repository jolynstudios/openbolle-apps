// dev: de app lokaal draaien met een testbroker en een pagina in de browser ("Bolle in de browser").
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, join, resolve } from "node:path";
import { Apparaat, startBroker } from "./broker.mjs";
import { foutenVoor, waarschuwingenVoor } from "./controleer.mjs";
import { antwoordVoorBolle, appVoorBolle, blokVoorBolle, hoofdblok } from "./bolle-usb.mjs";
import { openBolle, png, zoekPoort } from "./usb-node.mjs";
import { AANROEP, MANIFEST, PAKKET, actieProblemen, blokProblemen, controleerMelding, leesManifest, manifestNaam, postJson, startApp, vrijePoort, wachtOpGezond } from "./gedeeld.mjs";

const WEB_POORT = 4660;

function leesOpties(args) {
  const o = { map: ".", poort: WEB_POORT, plek: "", rijdt: false, site: [], bolle: null };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--poort") o.poort = Number(args[++i]);
    else if (a === "--plek") o.plek = args[++i] ?? "";
    else if (a === "--rijdt") o.rijdt = true;
    else if (a === "--site") o.site.push(String(args[++i] ?? "").replace(/\/$/, ""));
    else if (a === "--bolle") o.bolle = args[i + 1] && /^(\/dev\/|COM)/.test(args[i + 1]) ? args[++i] : "auto";
    else if (a.startsWith("-")) throw new Error(`Onbekende optie: ${a}`);
    else rest.push(a);
  }
  if (rest.length > 1) throw new Error(`Gebruik: ${AANROEP} dev [map] [--poort 4660] [--plek lat,lon] [--rijdt] [--site https://…] [--bolle [poort]]`);
  if (rest[0]) o.map = rest[0];
  if (!Number.isInteger(o.poort) || o.poort < 0 || o.poort > 65535) throw new Error("--poort moet een poortnummer zijn");
  return o;
}

function leesPlek(plek) {
  if (plek === undefined || plek === null || plek === "") return null;
  const d = String(plek).split(",").map((x) => Number(x.trim()));
  if (d.length !== 2 || d.some((x) => !Number.isFinite(x)) || Math.abs(d[0]) > 90 || Math.abs(d[1]) > 180) {
    throw new Error(`plek '${plek}' is geen geldige lat,lon (bijvoorbeeld 52.09,5.12)`);
  }
  return d;
}

function leesBody(req, max = 256 * 1024) {
  return new Promise((klaar, mislukt) => {
    const delen = [];
    let n = 0;
    req.on("data", (d) => { n += d.length; if (n > max) { mislukt(new Error("te groot")); req.destroy(); } else delen.push(d); });
    req.on("end", () => {
      const t = Buffer.concat(delen).toString("utf8");
      try { klaar(t ? JSON.parse(t) : {}); } catch { mislukt(new Error("verzoek is geen geldige JSON")); }
    });
    req.on("error", mislukt);
  });
}

export async function dev(args) {
  let o;
  try { o = leesOpties(args); } catch (e) { console.error(e.message); return 2; }
  const map = resolve(o.map);
  let m;
  try { m = leesManifest(map); } catch (e) { console.error(`${e.message}. Ga naar de map van je app, of geef hem op: ${AANROEP} dev <map>`); return 2; }
  try { leesPlek(o.plek); } catch (e) { console.error(e.message); return 2; }

  const fouten = foutenVoor(map);
  if (fouten.length) {
    console.log("Let op, het manifest is nog niet goed (de app start wel):");
    for (const f of fouten) console.log("  - " + f);
  } else for (const w of waarschuwingenVoor(map)) console.log("Let op: " + w);

  const rechten = new Set(m.rechten ?? []);
  const tools = new Map((m.tools ?? []).map((t) => [t.naam, t]));
  const blokken = new Map((m.blokken ?? []).map((b) => [b.id, b]));
  const hoofd = hoofdblok(m);                           /* alleen dit blok toont Bolle (net als de broker) */
  const apparaat = new Apparaat(m);                     /* wat de broker voor Bolle doet: lijst, beginscherm, melding één keer */
  const standaardInstellingen = Object.fromEntries((m.instellingen ?? []).filter((i) => "standaard" in i).map((i) => [i.sleutel, i.standaard]));

  const brokerPoort = await vrijePoort();
  const broker = await startBroker({ poort: brokerPoort, rechten: m.rechten, log: (r) => console.log(`[broker] ${r}`) });
  const appPoort = await vrijePoort();

  let stoppen = false;
  let kind;
  const servers = [broker.server];
  async function stop(code) {
    if (stoppen) return;
    stoppen = true;
    console.log("\nStoppen ...");
    try { if (bolle) { await bolle.usb.uit(); bolle.stop(); } } catch { /* Bolle al weg */ }
    await kind?.stop();
    for (const s of servers) { s.closeAllConnections?.(); s.close(); }
    process.exit(code);
  }
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));

  console.log(`App ${m.id} starten (${m.runtime?.taal}) op poort ${appPoort} ...`);
  try {
    kind = await startApp(map, m, { poort: appPoort, brokerUrl: `http://127.0.0.1:${brokerPoort}` });
  } catch (e) {
    console.error(`De app start niet: ${e.message}`);
    await stop(1);
    return 1;
  }
  kind.on("exit", (code, sig) => {
    if (stoppen) return;
    console.error(`De app stopte (${sig ?? "code " + code}). Verbeter de fout en start ${AANROEP} dev opnieuw.`);
    stop(1);
  });
  const leeft = () => kind.exitCode === null && kind.signalCode === null;
  if (!(await wachtOpGezond(appPoort, 180_000, leeft))) {
    if (!stoppen) {
      console.error(`De app antwoordt niet op GET /gezond (poort ${appPoort}). Luistert hij op de poort uit de omgeving (POORT)?`);
      await stop(1);
    }
    return 1;
  }
  try {
    const { json } = await postJson(`http://127.0.0.1:${appPoort}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/list" }, 5000);
    const namen = (json?.result?.tools ?? []).map((t) => t.name).sort();
    const verwacht = [...tools.keys()].sort();
    if (JSON.stringify(namen) !== JSON.stringify(verwacht)) {
      console.log(`Let op: tools/list geeft [${namen.join(", ")}], ${MANIFEST} heeft [${verwacht.join(", ")}]. Die moeten gelijk zijn.`);
    }
  } catch (e) {
    console.log(`Let op: tools/list lukt niet: ${e.message}`);
  }

  let teller = 0;
  /** De context zoals de broker hem zou sturen, met alleen wat de rechten toestaan. */
  let laatsteStaat = {};                                /* wat de pagina het laatst meegaf; voor tegels die Bolle zelf vraagt */
  function maakContext(staat) {
    if (staat && Object.keys(staat).some((k) => ["plek", "rijdt", "instellingen"].includes(k))) laatsteStaat = { plek: staat.plek, rijdt: staat.rijdt, instellingen: staat.instellingen };
    else staat = laatsteStaat;
    const notities = [];
    const ctx = {
      installatie: "ins_test",
      taal: "nl",
      instellingen: { ...standaardInstellingen, ...(staat.instellingen && typeof staat.instellingen === "object" ? staat.instellingen : {}) },
      aanroep_token: broker.token,
      verzoek_id: `dev-${++teller}`,
    };
    const plek = leesPlek(staat.plek === undefined ? o.plek : staat.plek);
    if (plek) {
      if (rechten.has("locatie:precies") || rechten.has("locatie:afgerond")) {
        const n = rechten.has("locatie:precies") ? 3 : 2;
        ctx.locatie = { lat: Number(plek[0].toFixed(n)), lon: Number(plek[1].toFixed(n)) };
      } else notities.push("De plek gaat niet mee: de app heeft geen recht locatie:afgerond of locatie:precies.");
    }
    const rijdt = staat.rijdt === undefined ? o.rijdt : Boolean(staat.rijdt);
    if (rechten.has("rit:status")) ctx.rijdt = rijdt;
    else if (rijdt) notities.push("'rijdt' gaat niet mee: de app heeft geen recht rit:status.");
    return { ctx, notities, rijdt };
  }

  async function roepToolAan(body) {
    const naam = String(body.naam ?? "");
    const t = tools.get(naam);
    if (!t) return [404, { fout: `onbekende tool '${naam}' (niet in ${MANIFEST})` }];
    const args = body.argumenten && typeof body.argumenten === "object" && !Array.isArray(body.argumenten) ? body.argumenten : {};
    const { ctx, notities, rijdt } = maakContext(body);
    if (rijdt && t.rijden === false) {
      return [200, { tekst: "Deze functie kan niet tijdens het rijden.", isError: true, door_broker: true, context: ctx, notities }];
    }
    if (t.bevestigen) notities.push("bevestigen: true. Op Bolle vraagt de assistent eerst \"Zal ik ...?\"; hier voer ik hem meteen uit.");
    const start = Date.now();
    const rq = { jsonrpc: "2.0", id: teller, method: "tools/call", params: { name: naam, arguments: args }, context: ctx };
    const { json } = await postJson(`http://127.0.0.1:${appPoort}/mcp`, rq, Math.max(10_000, (m.runtime?.tijdslimiet_ms ?? 4000) * 3));
    const ms = Date.now() - start;
    if (json?.error) return [200, { tekst: `JSON-RPC-fout ${json.error.code}: ${json.error.message}`, isError: true, antwoord: json, context: ctx, notities, ms }];
    const tekst = (json?.result?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("\n");
    const max = t.max_tekens ?? 600;
    const limiet = m.runtime?.tijdslimiet_ms ?? 4000;
    if (ms > limiet) notities.push(`Duurde ${ms} ms; op het platform is de tijdslimiet ${limiet} ms.`);
    if (tekst.length > max) notities.push(`Het taalmodel krijgt alleen de eerste ${max} tekens (max_tekens); dit antwoord heeft er ${tekst.length}.`);
    let melding;
    if (json?.result?.melding !== undefined && !json.result.isError) {
      const k = controleerMelding(json.result.melding, rechten, undefined, { bericht: false });
      if (k.melding) { melding = k.melding; notities.push(`Met melding "${melding.titel}" (icoon ${melding.icoon}${melding.kleur ? `, kleur ${melding.kleur}` : ""}${melding.geluid ? `, geluid ${melding.geluid}` : ", stil"}): Bolle toont hem zodra het antwoord is uitgesproken.`); }
      else notities.push(`De melding vervalt: ${k.reden}.`);
    }
    if (bolle && body.op_bolle !== false) {
      try {
        await bolle.usb.stuurJson("antwoord", antwoordVoorBolle(tekst.slice(0, max)));
        if (melding) await bolle.usb.stuurJson("melding", melding);
        notities.push("Ook op je Bolle getoond (berichten" + (melding ? " en melding" : "") + ").");
      } catch (e) { notities.push(`Niet op je Bolle: ${e.message}`); }
    }
    return [200, { tekst, isError: Boolean(json?.result?.isError), voor_het_model: tekst.slice(0, max), melding, antwoord: json, context: ctx, notities, ms }];
  }

  /**
   * Een blok ophalen zoals de broker het doet (blok_van). body: de staat van de pagina (plek, rijdt, instellingen), en
   * `meld`: zoals bij de lijst /v1/apps (/v1/plugins) die Bolle elke 2 minuten ophaalt (standaard; een melding uit het hoofdblok gaat
   * dan één keer naar Bolle). Bolle zelf vraagt een blok met meld: false (GET /v1/apps/<id>/blok, geen meldingen).
   * Antwoord: blok (zoals Bolle het krijgt), lijst (het item van /v1/apps), thuis (de regel op het beginscherm),
   * melding (als het blok er een heeft) en melding_naar_bolle (gaat hij nu naar Bolle, of was hij al gestuurd).
   */
  async function haalBlok(id, body) {
    const b = blokken.get(id);
    if (!b) return [404, { fout: `onbekend blok '${id}' (niet in ${MANIFEST})` }];
    const { ctx, notities, rijdt } = maakContext(body);
    const meld = body.meld !== false;
    const start = Date.now();
    const { status, json } = await postJson(`http://127.0.0.1:${appPoort}/blok/${encodeURIComponent(id)}`, { context: ctx },
      Math.max(10_000, (m.runtime?.tijdslimiet_ms ?? 4000) * 3));
    const ms = Date.now() - start;
    const goed = status === 200 && json && typeof json === "object" && !Array.isArray(json);
    if (!goed) return [200, { fout: `de app gaf HTTP ${status} en geen geldig blok`, antwoord: json, context: ctx, notities, ms }];
    for (const n of blokProblemen(json, rechten)) notities.push(n);
    const limiet = m.runtime?.tijdslimiet_ms ?? 4000;
    if (ms > limiet) notities.push(`Duurde ${ms} ms; op het platform is de tijdslimiet ${limiet} ms (daarna toont Bolle de vorige tegel).`);
    const isHoofd = b === hoofd;
    const uit = apparaat.blok(b, json, { rijdt, meld: meld && isHoofd });
    if (!uit.blok) notities.push("Zonder het recht blokken:tonen toont Bolle geen blok.");
    const blok = uit.blok ?? { titel: String(json.titel || b.titel), waarde: "", regels: [] };
    if (rijdt && (b.rijden ?? "volledig") === "verborgen") notities.push("De auto rijdt en dit blok heeft rijden: verborgen: Bolle toont alleen de titel.");
    else if (rijdt && b.rijden === "eenregel") notities.push("De auto rijdt en dit blok heeft rijden: eenregel: Bolle toont één regel.");
    if (!isHoofd) notities.push(`Dit is niet het hoofdblok (${hoofd?.id}): Bolle toont alleen het hoofdblok (hoofdscherm: true, anders het eerste).`);
    /* de melding: voor de voorbeeldweergave altijd, naar Bolle alleen de eerste keer (zoals de broker) */
    let melding = uit.melding.melding ?? undefined, naarBolle = uit.melding.nieuw;
    if (json.melding !== undefined && json.melding !== null) {
      if (!melding) { const k = controleerMelding(json.melding, rechten); if (k.melding) melding = k.melding; }
      if (!melding) notities.push(`De melding vervalt: ${uit.melding.reden ?? controleerMelding(json.melding, rechten).reden}.`);
      else if (!isHoofd) notities.push("De melding gaat niet naar Bolle: alleen een melding uit het hoofdblok gaat mee in de lijst.");
      else if (!meld) notities.push(`Met melding "${melding.titel}": die gaat alleen mee als Bolle de lijst ophaalt (elke 2 minuten), niet bij dit blok.`);
      else if (naarBolle) notities.push(`Met melding "${melding.titel}": de broker stuurt hem nu één keer naar Bolle, ook tijdens het rijden. Een nieuwe komt pas als "id" (of zonder id de titel) verandert, of als de melding er eerst even uit was.`);
      else notities.push(`Melding "${melding.titel}" is ${uit.melding.reden ?? "al gestuurd"}: Bolle krijgt hem niet nog eens. Verander "id", haal hem even uit het blok, of kies "Vergeet gestuurde melding".`);
    }
    const lijst = isHoofd && uit.blok ? apparaat.lijstItem(uit.blok, naarBolle ? melding : null) : null;
    if (bolle && body.op_bolle !== false && isHoofd && uit.blok) {
      try {
        await bolle.usb.stuurJson("blok", blokVoorBolle(blok));
        if (melding && naarBolle) await bolle.usb.stuurJson("melding", melding);
        notities.push("Ook op je Bolle gezet" + (melding && naarBolle ? ", met de melding." : "."));
      } catch (e) { notities.push(`Niet op je Bolle: ${e.message}`); }
    }
    return [200, { blok, hoofdblok: isHoofd, lijst, thuis: lijst ? apparaat.thuisRegel(lijst) : null, melding, melding_naar_bolle: naarBolle,
      antwoord: json, context: ctx, notities, ms }];
  }

  /**
   * Een antwoord van Bolle op een vraag, rij of knop: zoals POST /v1/apps/<id>/actie bij de broker (actie_van_bolle).
   * body: blok, actie, antwoord (ja|nee|tik|aan|uit) en de staat van de pagina (plek, rijdt, instellingen).
   * Geeft [http-code, {status, tekst (wat Bolle toont), antwoord (ruw), naar_bolle, melding, melding_naar_bolle, notities}].
   */
  async function doeActie(body) {
    const { ctx, notities, rijdt } = maakContext(body);
    const a = { blok: String(body.blok ?? ""), actie: String(body.actie ?? ""), antwoord: String(body.antwoord ?? "") };
    if (rijdt) return [409, { status: 409, fout: "Kan alleen als je stilstaat", tekst: "Kan alleen als je stilstaat",
      notities: ["De auto rijdt: de broker weigert elk antwoord (409) en Bolle toont \"Kan alleen als je stilstaat\". Op Bolle zelf kun je dan ook niet tikken."] }];
    if (!rechten.has("vragen:stellen")) return [403, { status: 403, fout: "Dat lukte niet", tekst: "Dat lukte niet",
      notities: [`De app heeft het recht vragen:stellen niet: de broker weigert het antwoord (403) en Bolle toont "Dat lukte niet". Zet vragen:stellen bij rechten in ${MANIFEST}.`] }];
    if (!["ja", "nee", "tik", "aan", "uit"].includes(a.antwoord)) return [400, { status: 400, fout: "antwoord: ja, nee, tik, aan of uit", tekst: "Dat lukte niet", notities: [] }];
    if (!/^[a-z0-9-]{1,32}$/.test(a.actie)) a.actie = "";
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(a.blok)) a.blok = "";
    const start = Date.now();
    let status, json;
    try {
      ({ status, json } = await postJson(`http://127.0.0.1:${appPoort}/actie`, { context: ctx, ...a }, Math.max(10_000, (m.runtime?.tijdslimiet_ms ?? 4000) * 3)));
    } catch (e) { status = 0; json = null; notities.push(`De app antwoordde niet goed op POST /actie: ${e.message}`); }
    const ms = Date.now() - start;
    if (status !== 200 || !json || typeof json !== "object" || Array.isArray(json)) {
      if (status === 404) notities.push("De app heeft geen POST /actie (in de SDK: actie in maakPlugin; in Python: de route /actie).");
      return [502, { status: 502, fout: "Dat lukte niet", tekst: "Dat lukte niet", antwoord: json, context: ctx, notities, ms }];
    }
    for (const n of actieProblemen(json, rechten)) notities.push(n);
    const limiet = m.runtime?.tijdslimiet_ms ?? 4000;
    if (ms > limiet) notities.push(`Duurde ${ms} ms; op het platform is de tijdslimiet ${limiet} ms (daarna toont Bolle "Dat lukte niet").`);
    const { antwoord, melding } = apparaat.actieAntwoord(json);
    if (melding.reden && !melding.nieuw && melding.melding) notities.push(`Melding "${melding.melding.titel}" is al gestuurd: Bolle krijgt hem niet nog eens.`);
    else if (melding.reden) notities.push(`De melding vervalt: ${melding.reden}.`);
    if (bolle && body.op_bolle !== false) {
      try { if (melding.nieuw) await bolle.usb.stuurJson("melding", melding.melding); } catch (e) { notities.push(`Niet op je Bolle: ${e.message}`); }
    }
    if (hoofd) haalBlok(hoofd.id, { meld: false, op_bolle: body.op_bolle }).catch(() => {});   /* Bolle haalt daarna het blok opnieuw */
    return [200, { status: 200, tekst: antwoord.tekst || "Doorgegeven", naar_bolle: antwoord, antwoord: json,
      melding: melding.melding ?? undefined, melding_naar_bolle: melding.nieuw, context: ctx, notities, ms }];
  }

  /**
   * GET /v1/apps en /v1/apps/<id>/blok zoals Bolle ze van de broker krijgt (lat, lon en rijdt in de query). De oude
   * paden /v1/plugins... werken ook, net als op het platform. De sleutel in de lijst blijft "plugins", zoals bij de broker.
   */
  async function apparaatApi(pad, query) {
    pad = pad.replace(/^\/api\/v1\/plugins(?=\/|$)/, "/api/v1/apps");
    const q = new URLSearchParams(query);
    /* zonder lat/lon of rijdt in de query: wat de pagina het laatst meegaf (net als Bolle, die ze alleen soms meestuurt) */
    const staat = { ...laatsteStaat, ...(q.has("lat") && q.has("lon") ? { plek: `${q.get("lat")},${q.get("lon")}` } : {}),
      ...(q.has("rijdt") ? { rijdt: q.get("rijdt") === "1" } : {}) };
    if (pad === "/api/v1/apps") {
      if (!hoofd) return [200, { plugins: [apparaat.lijstItem(null)] }];
      const [, j] = await haalBlok(hoofd.id, { ...staat, meld: true, op_bolle: false });
      return [200, { plugins: [j.lijst ?? apparaat.lijstItem(null)] }];
    }
    const id = decodeURIComponent(pad.slice("/api/v1/apps/".length, -"/blok".length));
    if (id !== m.id) return [404, { fout: "niet geïnstalleerd" }];
    if (!hoofd) return [200, { titel: m.naam, waarde: "", regels: [] }];
    const [, j] = await haalBlok(hoofd.id, { ...staat, meld: false, op_bolle: false });
    return [200, j.fout ? { titel: hoofd.titel, waarde: "", regels: [] } : j.blok];
  }

  /* --bolle: je eigen Bolle via USB (debugstand). De app staat dan ook op Bolle zelf: in Menu -> Apps, met zijn
   * scherm, en elk antwoord en elke melding van een tool verschijnt op Bolle. Bolle vraagt zelf om een nieuw blok. */
  let bolle = null, bolleFout = "";
  async function zetOpBolle() {
    const st = await bolle.usb.stand();
    if (!st.debug) throw new Error("de debugstand van Bolle staat uit: Menu -> Systeem -> Debug (of de knop op de pagina)");
    await bolle.usb.stuurJson("plugin", appVoorBolle(m));
    if (hoofd) await haalBlok(hoofd.id, { meld: false });
    return st;
  }
  async function verbindBolle() {                       /* ook opnieuw, na een herstart van Bolle (debugstand aan) */
    try { bolle?.stop(); } catch { /* al dicht */ }
    bolle = null; bolleFout = "";
    const poort = o.bolle === "auto" ? zoekPoort() : o.bolle;
    if (!poort) { bolleFout = "geen Bolle gevonden op USB"; return; }
    try {
      const b = openBolle(poort, { log: (soort, r) => { if (soort === "bolle" && /^DEV (VRAAG|UIT|fout)/.test(r)) console.log(`[bolle] ${r}`); } });
      bolle = b;
      /* "BLOK <app-id>": het scherm van de app is open (zonder meldingen); "LIJST": de lijst, elke 2 minuten (met melding) */
      b.usb.on("vraag", (v) => { if (hoofd) haalBlok(hoofd.id, { meld: !v.startsWith("BLOK ") }).catch(() => {}); });
      /* "DEV ACTIE <actie> <antwoord> <blok>": op Bolle getikt (vraag, rij of knop); Bolle zelf toont "Doorgegeven" */
      b.usb.on("actie", ({ actie, antwoord, blok }) => {
        doeActie({ actie, antwoord, blok }).then(([, j]) => console.log(`[bolle] actie ${actie || "-"} ${antwoord}: ${j.tekst}`)).catch(() => {});
      });
      b.usb.on("fout", (e) => { if (bolle === b) { bolleFout = e.message; console.log(`[bolle] ${e.message}`); } });
      const st = await zetOpBolle();
      console.log(`Je Bolle (${poort}, BolleOS ${st.versie}): ${m.naam} staat bovenaan in Menu -> Apps.`);
    } catch (e) { bolleFout = e.message; console.log(`Je Bolle: ${e.message}`); }
  }
  if (o.bolle) await verbindBolle();
  const UI_MAG = /^(UI menu( plugins| plugin [a-z0-9_-]+)?|UI home|UI open (klok|overzicht|menu|ogen))$/;

  const pagina = readFileSync(join(PAKKET, "cli", "pagina.html"), "utf8");
  const usbModule = readFileSync(join(PAKKET, "cli", "bolle-usb.mjs"), "utf8");
  /* De simulator op de site van openBolle mag deze server gebruiken (CORS, en Chrome vraagt bij een publieke site
   * naar 127.0.0.1 ook om Private Network Access). Alleen deze adressen, zodat een willekeurige site niet bij je
   * app kan terwijl dev draait. Een eigen site of poort: --site https://… */
  const SITES = new Set(["https://openbolle.nl", "https://www.openbolle.nl", "https://openbolle.nl", ...o.site]);
  const magSite = (h) => !!h && (SITES.has(h) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(h));
  const web = createServer(async (req, res) => {
    const herkomst = req.headers.origin;
    const kop = magSite(herkomst) ? { "Access-Control-Allow-Origin": herkomst, Vary: "Origin" } : {};
    const stuur = (code, obj, type = "application/json; charset=utf-8") => {
      const b = Buffer.isBuffer(obj) ? obj : Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj));
      res.writeHead(code, { "Content-Type": type, "Content-Length": b.length, "Cache-Control": "no-store", ...kop });
      res.end(b);
    };
    const pad = (req.url ?? "/").split("?")[0];
    if (req.method === "OPTIONS") {
      if (!magSite(herkomst)) { res.writeHead(403); return res.end(); }
      res.writeHead(204, { ...kop, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Private-Network": "true", "Access-Control-Max-Age": "600" });
      return res.end();
    }
    if (herkomst && !magSite(herkomst) && pad.startsWith("/api/")) return stuur(403, { fout: `herkomst ${herkomst} niet toegestaan (gebruik --site)` });
    try {
      if (req.method === "GET" && (pad === "/" || pad === "/index.html")) return stuur(200, pagina, "text/html; charset=utf-8");
      if (req.method === "GET" && pad === "/api/info") {
        return stuur(200, { manifest: m, map: basename(map), hoofdblok: hoofd?.id ?? null, bestand: manifestNaam(map), standaard: { plek: o.plek, rijdt: o.rijdt, instellingen: standaardInstellingen } });
      }
      if (req.method === "GET" && pad === "/api/logo") {
        if (!m.logo) return stuur(404, { fout: "geen logo" });
        try { return stuur(200, readFileSync(join(map, m.logo)), "image/png"); } catch { return stuur(404, { fout: "logo niet gevonden" }); }
      }
      if (req.method === "GET" && pad === "/bolle-usb.mjs") return stuur(200, usbModule, "text/javascript; charset=utf-8");
      if (req.method === "GET" && pad === "/api/bolle") return stuur(200, { aan: Boolean(o.bolle), verbonden: Boolean(bolle) && !bolleFout, poort: bolle?.poort ?? null, fout: bolleFout, debug: bolle?.usb.debug ?? null, plugin: bolle?.usb.plugin ?? null, versie: bolle?.usb.versie ?? "" });
      if (pad.startsWith("/api/bolle/") && pad !== "/api/bolle/opnieuw" && !bolle) return stuur(409, { fout: bolleFout || "start dev met --bolle om je Bolle via USB te gebruiken" });
      if (req.method === "GET" && pad === "/api/bolle/scherm") return stuur(200, png(await bolle.usb.scherm(Math.min(4, Math.max(1, Number(new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("n")) || 2)))), "image/png");
      if (req.method === "POST" && pad === "/api/bolle/tik") { const b = await leesBody(req); await bolle.usb.tik(Number(b.x), Number(b.y)); return stuur(200, { ok: true }); }
      if (req.method === "POST" && pad === "/api/bolle/opdracht") {
        const r = String((await leesBody(req)).opdracht ?? "");
        if (r === "DEBUG 1" || UI_MAG.test(r)) { await bolle.usb.opdracht(r); return stuur(200, { ok: true }); }
        return stuur(400, { fout: "deze opdracht mag niet vanaf de pagina" });
      }
      if (req.method === "POST" && pad === "/api/bolle/opnieuw") { await verbindBolle(); return stuur(200, { fout: bolleFout, debug: bolle?.usb.debug ?? null }); }
      if (req.method === "POST" && pad === "/api/tool") return stuur(...(await roepToolAan(await leesBody(req))));
      if (req.method === "POST" && pad.startsWith("/api/blok/")) {
        return stuur(...(await haalBlok(decodeURIComponent(pad.slice("/api/blok/".length)), await leesBody(req))));
      }
      if (req.method === "POST" && pad === "/api/melding/vergeet") { apparaat.vergeet(); return stuur(200, { ok: true }); }
      if (req.method === "POST" && pad === "/api/actie") { const [, j] = await doeActie(await leesBody(req)); return stuur(200, j); }
      /* zoals Bolle het de broker vraagt (de simulator op de site): rijdt, lat en lon in de query, echte statuscodes */
      const actieM = /^\/api\/v1\/(?:apps|plugins)\/([^/]+)\/actie$/.exec(pad);
      if (req.method === "POST" && actieM) {
        if (decodeURIComponent(actieM[1]) !== m.id) return stuur(404, { fout: "niet geïnstalleerd" });
        const q = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
        const staat = { ...laatsteStaat, ...(q.has("lat") && q.has("lon") ? { plek: `${q.get("lat")},${q.get("lon")}` } : {}), ...(q.has("rijdt") ? { rijdt: q.get("rijdt") === "1" } : {}) };
        const [code, j] = await doeActie({ ...(await leesBody(req)), ...staat });
        return stuur(code, code === 200 ? j.naar_bolle : { fout: j.fout });
      }
      if (req.method === "GET" && /^\/api\/v1\/(apps|plugins)(\/[^/]+\/blok)?$/.test(pad)) {
        return stuur(...(await apparaatApi(pad, (req.url ?? "").split("?")[1] ?? "")));
      }
      stuur(404, { fout: "niet gevonden" });
    } catch (e) {
      stuur(500, { fout: e.name === "TimeoutError" ? "de app antwoordde niet op tijd" : e.message });
    }
  });
  servers.push(web);
  const webPoort = await vrijePoort(o.poort);
  await new Promise((ok) => web.listen(webPoort, "127.0.0.1", ok));
  console.log(`
Bolle in de browser: http://127.0.0.1:${webPoort}/
  app      http://127.0.0.1:${appPoort}  (${m.id})${o.bolle ? `\n  bolle    ${bolle ? bolle.poort : "-"}  ${bolleFout || "op je eigen Bolle (debugstand)"}` : ""}
  broker   http://127.0.0.1:${brokerPoort}  (testbroker: opslag in het geheugen, voorbeelddata)
  lijst    http://127.0.0.1:${webPoort}/api/v1/apps  (zoals Bolle hem van de broker krijgt)
  actie    POST http://127.0.0.1:${webPoort}/api/v1/apps/${m.id}/actie?rijdt=0  {"blok", "actie", "antwoord"}
Pas je je code aan, start dan opnieuw. Stoppen: Ctrl-C.
`);
  return new Promise(() => {}); // blijft draaien tot Ctrl-C
}
