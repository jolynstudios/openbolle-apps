// Gedeeld door nieuw, dev en controleer: paden, manifest lezen, vrije poort, app starten.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

/** Hoofdmap van dit pakket (waar schema/, sjabloon/ en tools/ staan). */
export const PAKKET = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const AANROEP = "npx github:jolynstudios/openbolle-apps";

/** De namen die BolleOS kent (iconen, kleuren, geluiden), voor een melding van een app. */
export function leesNamen() {
  return JSON.parse(readFileSync(join(PAKKET, "schema", "bolleos.json"), "utf8"));
}

/** Kleuren van een alarm: alleen betekenissen van Bolle, nooit die van flitsers of een eigen kleur (broker.py: ALARM_KLEUREN). */
export const ALARM_KLEUREN = ["info", "ok", "gevaar", "ernstig", "agenda", "telefoon"];
/** Een alarm mag ook een Nederlandse pictogramnaam als icoon hebben; de broker zet hem om (broker.py: NL_ICOON). */
export const NL_ICOON = { laadpaal: "bolt", bliksem: "bolt", stekker: "bolt", batterij: "bolt", huis: "home", deur: "home",
  auto: "car", garage: "car", parkeren: "car", route: "traj", muziek: "music", bericht: "msg", agenda: "cal", klok: "clock",
  regen: "rain", wolk: "rain", zon: "sun", lamp: "sun", hart: "heart", camera: "cam", instellingen: "gear", alarm: "bell",
  brandstof: "drop", thermometer: "drop", pin: "flag", vraag: "info", vink: "check", kruis: "x", lijst: "grid", ster: "star" };
const HEX = /^#[0-9A-Fa-f]{6}$/;
const bytes = (s) => Buffer.byteLength(String(s));

/**
 * Alles wat er aan een melding mis is, zoals melding_van() in de broker het bekijkt. Leeg = goed. De broker laat een
 * melding met één fout helemaal vallen; het antwoord of blok zelf blijft.
 *   vorm "alarm" (standaard): titel (≤ 27 bytes), icoon (BolleOS of een pictogramnaam), kleur (een betekenis), geluid
 *   vorm "bericht": titel (≤ 23 bytes), tekst (≤ 70, langer wordt ingekort), kleur (#RRGGBB, anders genegeerd)
 * bericht: false bij een tool (het antwoord gaat via de spraakserver, die kent alleen een alarm).
 */
export function meldingProblemen(x, rechten, namen = leesNamen(), { bericht = true } = {}) {
  const p = [];
  if (!rechten.has("meldingen:sturen")) p.push("de app heeft het recht meldingen:sturen niet");
  if (!x || typeof x !== "object" || Array.isArray(x)) return [...p, "melding moet een object zijn"];
  const { titel, icoon, kleur, geluid } = x;
  const vorm = x.vorm ?? "alarm";
  if (vorm !== "alarm" && vorm !== "bericht") return [...p, `onbekende vorm: ${vorm} (alarm of bericht)`];
  if (vorm === "bericht" && !bericht) return [...p, "een bericht kan alleen in een blok of bij een actie; bij een tool alleen een alarm"];
  if (typeof titel !== "string" || !titel.trim() || /[\u0000-\u001f]/.test(titel)) p.push("titel ontbreekt");
  if (vorm === "bericht") {
    if (typeof titel === "string" && bytes(titel.trim()) > 23) p.push("titel is te lang voor een bericht (hooguit 23 bytes, ongeveer 20 tekens)");
    return p;
  }
  if (typeof titel === "string" && bytes(titel.trim()) > 27) p.push("titel is te lang (hooguit 27 bytes, ongeveer 24 tekens)");
  if (!namen.iconen.includes(NL_ICOON[icoon] ?? icoon)) p.push(`onbekend icoon: ${icoon}`);
  if (kleur != null && !ALARM_KLEUREN.includes(kleur)) p.push(`kleur ${kleur} mag niet in een alarm (alleen ${ALARM_KLEUREN.join(" ")}; geen eigen kleur, zodat een app nooit op een flitser lijkt)`);
  if (geluid != null && !namen.geluiden.includes(geluid)) p.push(`onbekend geluid: ${geluid}`);
  return p;
}

/** Wat er aan een melding beter kan maar hem niet laat vallen (de broker kort in of laat een veld weg). */
export function meldingOpmerkingen(x) {
  if (!x || typeof x !== "object" || x.vorm !== "bericht") return [];
  const p = [];
  if (x.tekst !== undefined && tekens(x.tekst) > 70) p.push(`de tekst van het bericht is ${tekens(x.tekst)} tekens; de broker kort in tot 70.`);
  if (x.kleur !== undefined && !(typeof x.kleur === "string" && HEX.test(x.kleur))) p.push(`kleur ${x.kleur} van een bericht moet #RRGGBB zijn; de broker laat hem weg.`);
  return p;
}

/**
 * Kijkt een melding na zoals de broker dat doet. Geeft { melding } terug zoals hij naar Bolle gaat, anders { reden }.
 */
export function controleerMelding(x, rechten, namen = leesNamen(), opties = {}) {
  const p = meldingProblemen(x, rechten, namen, opties);
  if (p.length) return { reden: p[0] };
  const { titel, kleur, geluid } = x;
  if (x.vorm === "bericht") {
    const tekst = kortTekst(x.tekst, 70, 71);
    return { melding: { vorm: "bericht", titel: titel.trim(), icoon: "msg", ...(tekst ? { tekst } : {}),
      ...(typeof kleur === "string" && HEX.test(kleur) ? { kleur: kleur.toUpperCase() } : {}) } };
  }
  const icoon = NL_ICOON[x.icoon] ?? x.icoon;
  return { melding: { titel: titel.trim(), icoon, ...(kleur ? { kleur } : {}), ...(geluid ? { geluid } : {}) } };
}

/** Lengte in tekens (code points), zoals Python len() telt. */
const tekens = (s) => Array.from(String(s ?? "")).length;

/** kort() van de broker: hooguit n tekens en nb bytes, zonder stuurtekens; geen tekst of getal = "". */
export function kortTekst(x, n, nb) {
  if (typeof x === "boolean" || !["string", "number"].includes(typeof x)) return "";
  let s = Array.from(String(x).replace(/[\u0000-\u001f\u007f]/g, " ").trim()).slice(0, n);
  while (nb && bytes(s.join("")) > nb) s.pop();
  return s.join("");
}

/** De soorten scherm (blok v2, BolleOS 1.2) en de grenzen van Bolle (firmware plugins.h; broker.py kort ze in). */
export const SOORTEN = ["waarde", "kaarten", "vraag", "lijst", "knoppen"];
export const GRENS = { schermen: 4, kaarten: 8, rijen: 6, knoppen: 4, titel: 16, waardeGetal: 8, waardeTekst: 10, eenheid: 10,
  regel: 24, kaartTitel: 60, kaartTekst: 70, bron: 24, vraag: 60, uitleg: 60, jaNee: 10, rijTekst: 24, rijSchakelaar: 10,
  rijWaarde: 10, knop: 14, knoppenTekst: 10, actieTekst: 40 };
export const ACTIE = /^[a-z0-9-]{1,32}$/;
/** Past de waarde in het grote cijferfont (alleen 0-9 , . : - / % °)? */
export const isGetal = (s) => /^[0-9,.:\-/%°]+$/.test(String(s ?? ""));

/** De soort die Bolle kiest (firmware plugins_blok.c, scherm_lees): de gegeven soort als die past, anders afgeleid. */
export function soortVan(s) {
  const nk = Array.isArray(s.kaarten) ? s.kaarten.filter((k) => k && typeof k === "object" && k.titel).length : 0;
  const nr = Array.isArray(s.rijen) ? s.rijen.filter((r) => r && typeof r === "object" && r.tekst).length : 0;
  const nkn = Array.isArray(s.knoppen) ? s.knoppen.filter((k) => k && typeof k === "object" && k.tekst && k.actie).length : 0;
  const vr = s.vraag && typeof s.vraag === "object" && s.vraag.tekst;
  const t = s.soort;
  if (t === "vraag" && vr) return "vraag";
  if (t === "knoppen" && nkn >= 2) return "knoppen";
  if (t === "lijst" && nr) return "lijst";
  if (t === "kaarten" || t === "waarde") return t;
  if (vr) return "vraag";
  if (nkn >= 2) return "knoppen";
  if (nr) return "lijst";
  if (nk) return "kaarten";
  if (s.waarde || typeof s.meter === "number" || typeof s.meter2 === "number") return "waarde";
  return "kaarten";
}

const PICTOGRAMMEN = () => leesSchema().$defs?.pictogram?.enum ?? [];

function knopProblemen(k, waar, max, p, acties) {
  if (k === undefined) return;
  if (!k || typeof k !== "object") return void p.push(`${waar}: een knop is een object met tekst en actie.`);
  if (!k.tekst) p.push(`${waar}: de knop heeft geen tekst; de broker laat hem weg.`);
  else if (tekens(k.tekst) > max) p.push(`${waar}: knoptekst "${k.tekst}" is ${tekens(k.tekst)} tekens; er passen er ${max}.`);
  if (!ACTIE.test(String(k.actie ?? ""))) p.push(`${waar}: actie ${JSON.stringify(k.actie)} moet a-z, 0-9 en - zijn (hooguit 32); zonder geldige actie valt de knop weg.`);
  else acties.push(k.actie);
  if (k.pictogram !== undefined && !PICTOGRAMMEN().includes(k.pictogram)) p.push(`${waar}: onbekend pictogram ${k.pictogram}; de broker laat het weg.`);
}

function lang(p, waar, veld, x, max, extra = "") {
  if (x !== undefined && x !== null && tekens(x) > max) p.push(`${waar}${veld} is ${tekens(x)} tekens; er passen er ${max}${extra}.`);
}

/** Wat er aan één scherm beter kan. `waar`: "" of "scherm 2: ". acties: verzamelt de acties (voor vragen:stellen). */
function schermProblemen(s, waar, p, acties, metRegels) {
  if (s.soort !== undefined && !SOORTEN.includes(s.soort)) p.push(`${waar}onbekende soort ${JSON.stringify(s.soort)} (${SOORTEN.join(", ")}).`);
  const soort = soortVan(s);
  if (s.soort && SOORTEN.includes(s.soort) && s.soort !== soort) p.push(`${waar}soort ${s.soort} zonder de velden ervan; Bolle toont het als ${soort}.`);
  if (s.titel && tekens(s.titel) > GRENS.titel) p.push(`${waar}titel is ${tekens(s.titel)} tekens; op het scherm passen er ${GRENS.titel}.`);
  for (const [k, m] of [["meter", "de buitenste ring"], ["meter2", "de binnenste ring"]]) {
    if (s[k] !== undefined && s[k] !== null && !(typeof s[k] === "number" && Number.isFinite(s[k]) && s[k] >= 0 && s[k] <= 100)) {
      p.push(`${waar}${k} (${m}) moet een getal van 0 tot 100 zijn; de broker laat ${JSON.stringify(s[k])} weg.`);
    }
  }
  if (soort === "waarde") {
    const w = String(s.waarde ?? "");
    const max = isGetal(w) ? GRENS.waardeGetal : GRENS.waardeTekst;
    if (tekens(w) > max) p.push(`${waar}waarde "${w}" is ${tekens(w)} tekens; groot passen er ${max}${isGetal(w) ? " cijfers" : ""} (daarna kleiner).`);
    lang(p, waar, "eenheid", s.eenheid, GRENS.eenheid);
    lang(p, waar, "regel", s.regel, GRENS.regel, " (één regel, daarna puntjes)");
    if (typeof s.meter2 === "number" && typeof s.meter !== "number") p.push(`${waar}meter2 zonder meter: Bolle tekent die ring dan als de buitenste.`);
    if (!w && typeof s.meter !== "number" && typeof s.meter2 !== "number" && !metRegels) p.push(`${waar}een waarde-scherm zonder waarde of meter is leeg; Bolle slaat het over.`);
    knopProblemen(s.knop, `${waar}knop`, GRENS.knop, p, acties);
  } else if (s.knop !== undefined) p.push(`${waar}een knop hoort bij een waarde-scherm of een kaart; bij ${soort} tekent Bolle hem niet.`);
  if (soort === "kaarten") {
    const k = Array.isArray(s.kaarten) ? s.kaarten : [];
    if (s.kaarten !== undefined && !Array.isArray(s.kaarten)) p.push(`${waar}kaarten moet een lijst zijn.`);
    if (k.length > GRENS.kaarten) p.push(`${waar}${k.length} kaarten; Bolle toont er ${GRENS.kaarten}.`);
    k.slice(0, GRENS.kaarten).forEach((x, i) => {
      const w2 = `${waar}kaart ${i + 1}: `;
      if (!x || typeof x !== "object" || !x.titel) return void p.push(`${w2}geen titel; Bolle slaat de kaart over.`);
      lang(p, w2, "titel", x.titel, GRENS.kaartTitel);
      lang(p, w2, "tekst", x.tekst, GRENS.kaartTekst, " (twee regels)");
      lang(p, w2, "bron", x.bron, GRENS.bron);
      knopProblemen(x.knop, `${w2}knop`, GRENS.knop, p, acties);
    });
    if (!k.length && !metRegels) p.push(`${waar}geen kaarten en geen regels: Bolle toont "Deze app laat hier niets zien".`);
    if (!k.length && metRegels && s.soort === undefined) p.push(`${waar}zonder soort worden de regels kaarten (één per kaart, BolleOS 1.2). Kies liever een soort, bijvoorbeeld waarde of kaarten.`);
  }
  if (soort === "vraag") {
    const v = s.vraag;
    lang(p, `${waar}vraag: `, "tekst", v.tekst, GRENS.vraag);
    lang(p, `${waar}vraag: `, "uitleg", v.uitleg, GRENS.uitleg);
    lang(p, `${waar}vraag: `, "ja", v.ja, GRENS.jaNee);
    lang(p, `${waar}vraag: `, "nee", v.nee, GRENS.jaNee);
    if (v.actie !== undefined && !ACTIE.test(String(v.actie))) p.push(`${waar}vraag: actie ${JSON.stringify(v.actie)} moet a-z, 0-9 en - zijn (hooguit 32); de broker laat hem weg.`);
    acties.push(v.actie ?? "(vraag)");
  }
  if (soort === "lijst") {
    const r = s.rijen;
    if (r.length > GRENS.rijen) p.push(`${waar}${r.length} rijen; Bolle toont er ${GRENS.rijen}.`);
    r.slice(0, GRENS.rijen).forEach((x, i) => {
      const w2 = `${waar}rij ${i + 1}: `;
      if (!x || typeof x !== "object" || !x.tekst) return void p.push(`${w2}geen tekst; Bolle slaat de rij over.`);
      const schakelaar = typeof x.aan === "boolean";
      lang(p, w2, "tekst", x.tekst, schakelaar ? GRENS.rijSchakelaar : GRENS.rijTekst, schakelaar ? " naast een schakelaar (daarna puntjes)" : "");
      lang(p, w2, "waarde", x.waarde, GRENS.rijWaarde);
      if (schakelaar && x.waarde) p.push(`${w2}een rij met een schakelaar toont geen waarde.`);
      if (x.aan !== undefined && !schakelaar) p.push(`${w2}aan moet true of false zijn.`);
      if (x.pictogram !== undefined && !PICTOGRAMMEN().includes(x.pictogram)) p.push(`${w2}onbekend pictogram ${x.pictogram}; de broker laat het weg.`);
      if (x.actie !== undefined) { if (!ACTIE.test(String(x.actie))) p.push(`${w2}actie ${JSON.stringify(x.actie)} moet a-z, 0-9 en - zijn (hooguit 32); de rij wordt alleen om te lezen.`); else acties.push(x.actie); }
      else if (schakelaar) p.push(`${w2}een schakelaar zonder actie kun je niet omzetten.`);
    });
  }
  if (soort === "knoppen" || (s.knoppen !== undefined && soort !== "knoppen")) {
    const k = Array.isArray(s.knoppen) ? s.knoppen : [];
    if (soort !== "knoppen") p.push(`${waar}knoppen: Bolle tekent er 2 tot 4; met ${k.length} wordt het geen knoppen-scherm.`);
    if (k.length > GRENS.knoppen) p.push(`${waar}${k.length} knoppen; Bolle toont er ${GRENS.knoppen}.`);
    k.slice(0, GRENS.knoppen).forEach((x, i) => knopProblemen(x, `${waar}knop ${i + 1}`, GRENS.knoppenTekst, p, acties));
  }
}

/**
 * Wat er aan het ruwe blok van een app (het antwoord op POST /blok/<id>) beter kan, gemeten aan het scherm van Bolle
 * (BolleOS 1.2: de soorten scherm, firmware plugins.h) en aan de broker (blok_van, blok_v2). Voor `dev` (notities) en
 * `controleer --contract` (let op). Leeg = niets op aan te merken.
 */
export function blokProblemen(j, rechten, namen = leesNamen()) {
  if (!j || typeof j !== "object" || Array.isArray(j)) return ["het antwoord is geen blok (een JSON-object, bijvoorbeeld {\"soort\": \"waarde\", \"titel\": ..., \"waarde\": ...})"];
  const p = [], acties = [];
  if (j.regels !== undefined && !Array.isArray(j.regels)) p.push("regels moet een lijst zijn.");
  const regels = Array.isArray(j.regels) ? j.regels.map(String) : [];
  if (regels.length > 6) p.push(`${regels.length} regels; de broker geeft er 6 door (de assistent leest ze voor).`);
  const lng = regels.filter((r) => tekens(r) > 120).length;
  if (lng) p.push(`${lng} regel${lng > 1 ? "s zijn" : " is"} langer dan 120 tekens; de broker kapt af.`);
  if (j.kleur !== undefined && !(typeof j.kleur === "string" && HEX.test(j.kleur))) p.push(`kleur ${JSON.stringify(j.kleur)} moet #RRGGBB zijn; de broker laat hem weg (dan de kleur van Bolle).`);
  if (j.blok !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(String(j.blok))) p.push(`blok ${JSON.stringify(j.blok)} moet a-z, 0-9, _ en - zijn (hooguit 32); de broker laat het weg.`);
  if (j.titel && tekens(j.titel) > GRENS.titel) p.push(`titel is ${tekens(j.titel)} tekens; op het scherm passen er ${GRENS.titel} (de broker kapt af bij 24).`);
  if (j.schermen !== undefined) {
    if (!Array.isArray(j.schermen)) p.push("schermen moet een lijst zijn.");
    else {
      if (j.schermen.length > GRENS.schermen) p.push(`${j.schermen.length} schermen; Bolle toont er ${GRENS.schermen}.`);
      j.schermen.slice(0, GRENS.schermen).forEach((s, i) => {
        if (!s || typeof s !== "object" || Array.isArray(s)) return void p.push(`scherm ${i + 1} is geen object.`);
        for (const k of ["blok", "kleur", "regels", "melding", "schermen"]) if (k in s) p.push(`scherm ${i + 1}: ${k} hoort bij het blok, niet bij een scherm.`);
        schermProblemen(s, `scherm ${i + 1}: `, p, acties, regels.length > 0);
      });
      // waarde, meter en regels naast schermen mogen: die gebruikt een oudere Bolle (1.1) en het beginscherm
      for (const k of ["kaarten", "vraag", "rijen", "knoppen", "knop"]) {
        if (k in j) p.push(`${k} staat naast schermen; met schermen toont Bolle alleen de schermen: zet ${k} in een scherm.`);
      }
    }
  } else schermProblemen(j, "", p, acties, regels.length > 0);
  if (acties.length && !rechten.has("vragen:stellen")) p.push("het scherm heeft knoppen, een vraag of rijen met een actie, maar het recht vragen:stellen ontbreekt: de broker weigert het antwoord (403).");
  if (j.melding !== undefined && j.melding !== null) {
    for (const x of meldingProblemen(j.melding, rechten, namen)) p.push(`melding: ${x}; de broker laat de melding vallen.`);
    for (const x of meldingOpmerkingen(j.melding)) p.push(`melding: ${x}`);
    if (j.melding && typeof j.melding === "object" && j.melding.id !== undefined && String(j.melding.id) === "") {
      p.push("melding: id is leeg; dan stuurt de broker hem nooit. Laat id weg of geef een waarde.");
    }
  }
  return p;
}

/** Wat er aan het antwoord op POST /actie beter kan ({tekst ≤ 40, melding?}). */
export function actieProblemen(j, rechten, namen = leesNamen()) {
  if (!j || typeof j !== "object" || Array.isArray(j)) return ["het antwoord op /actie is geen object {\"tekst\": ...}"];
  const p = [];
  if (!j.tekst) p.push("geen tekst: Bolle toont dan \"Doorgegeven\".");
  else if (tekens(j.tekst) > GRENS.actieTekst) p.push(`tekst is ${tekens(j.tekst)} tekens; de broker kort in tot ${GRENS.actieTekst}.`);
  if (j.melding !== undefined && j.melding !== null) {
    for (const x of meldingProblemen(j.melding, rechten, namen)) p.push(`melding: ${x}; de broker laat de melding vallen.`);
    for (const x of meldingOpmerkingen(j.melding)) p.push(`melding: ${x}`);
  }
  return p;
}

export function leesSchema() {
  return JSON.parse(readFileSync(join(PAKKET, "schema", "app.schema.json"), "utf8"));
}

/**
 * De naam van het manifest van een app, en de namen die we ook lezen (de eerste die bestaat telt). plugin.yaml is de
 * oude naam: die lezen we nog, zodat bestaande apps en winkels blijven werken.
 */
export const MANIFEST = "app.yaml";
export const MANIFEST_NAMEN = ["app.yaml", "plugin.yaml"];

/** De mappen met apps in een repo of winkel: apps/<id>/ en (de oude naam) plugins/<id>/. */
export const APP_MAPPEN = ["apps", "plugins"];

/** De bestandsnaam van het manifest in `map` (de eerste uit MANIFEST_NAMEN die bestaat), of MANIFEST als er geen is. */
export function manifestNaam(map) {
  return MANIFEST_NAMEN.find((n) => existsSync(join(map, n))) ?? MANIFEST;
}

/** Staat er een manifest in `map`? */
export const heeftManifest = (map) => MANIFEST_NAMEN.some((n) => existsSync(join(map, n)));

/** Alle mappen in apps/ en plugins/ onder `root` (gesorteerd per map), met of zonder manifest. */
export function appMappen(root) {
  const uit = [];
  for (const a of APP_MAPPEN) {
    const d = join(root, a);
    if (!existsSync(d) || !statSync(d).isDirectory()) continue;
    for (const n of readdirSync(d).sort()) if (statSync(join(d, n)).isDirectory()) uit.push(join(d, n));
  }
  return uit;
}

/** Heeft `root` een map apps/ of plugins/? */
export const heeftAppMap = (root) => APP_MAPPEN.some((a) => existsSync(join(root, a)));

/** Leest het manifest (app.yaml, of het oude plugin.yaml) in een map. Gooit een Error met een Nederlandse melding. */
export function leesManifest(map) {
  const naam = manifestNaam(map), pad = join(map, naam);
  if (!existsSync(pad)) throw new Error(`geen ${MANIFEST} in ${map}`);
  const doc = YAML.parseDocument(readFileSync(pad, "utf8"), { prettyErrors: true });
  if (doc.errors.length) throw new Error(`${naam} is geen geldige YAML: ${doc.errors[0].message.split("\n")[0]}`);
  return doc.toJS();
}

/** Een vrije TCP-poort op 127.0.0.1 (of de gevraagde, als die vrij is). */
export function vrijePoort(liefst = 0) {
  return new Promise((klaar, mislukt) => {
    const s = createServer();
    s.unref();
    s.once("error", (e) => (liefst ? vrijePoort(0).then(klaar, mislukt) : mislukt(e)));
    s.listen(liefst, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => klaar(port));
    });
  });
}

export const wacht = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wacht tot GET /gezond 200 geeft. Geeft false bij timeout of als `nogBezig()` false wordt. */
export async function wachtOpGezond(poort, timeoutMs, nogBezig = () => true) {
  const eind = Date.now() + timeoutMs;
  while (Date.now() < eind && nogBezig()) {
    try {
      const r = await fetch(`http://127.0.0.1:${poort}/gezond`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return true;
    } catch { /* nog niet */ }
    await wacht(300);
  }
  return false;
}

/** POST JSON naar de app en geef de JSON terug. */
export async function postJson(url, obj, timeoutMs = 10_000) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const tekst = await r.text();
  let json;
  try { json = JSON.parse(tekst); } catch { throw new Error(`antwoord is geen JSON (HTTP ${r.status}): ${tekst.slice(0, 200)}`); }
  return { status: r.status, json };
}

function heeftPython() {
  return new Promise((klaar) => {
    const p = spawn("python3", ["--version"], { stdio: "ignore" });
    p.on("error", () => klaar(false));
    p.on("exit", (c) => klaar(c === 0));
  });
}

function draai(cmd, args, opties) {
  return new Promise((klaar, mislukt) => {
    const p = spawn(cmd, args, opties);
    p.on("error", mislukt);
    p.on("exit", (c) => (c === 0 ? klaar() : mislukt(new Error(`${cmd} ${args.join(" ")} stopte met code ${c}`))));
  });
}

/**
 * Start de app in `map` lokaal (zonder Docker) op `poort`. Geeft het kindproces terug (eigen procesgroep, zodat
 * stop() ook npm en tsc/node eronder stopt). `uitvoer`: "erven" (naar de terminal) of "stil".
 */
export async function startApp(map, manifest, { poort, brokerUrl, uitvoer = "erven", log = console.log } = {}) {
  const taal = manifest?.runtime?.taal;
  const env = { ...process.env, POORT: String(poort), PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" };
  if (brokerUrl) env.BROKER_URL = brokerUrl;
  const stdio = uitvoer === "stil" ? "ignore" : "inherit";
  let cmd, args;
  if (taal === "python") {
    if (!existsSync(join(map, "plugin.py"))) throw new Error("runtime.taal is python, maar plugin.py ontbreekt");
    if (!(await heeftPython())) throw new Error("python3 niet gevonden; installeer Python 3 om deze app te draaien");
    cmd = "python3"; args = ["plugin.py"];
  } else if (taal === "node") {
    const pj = join(map, "package.json");
    if (!existsSync(pj)) throw new Error("runtime.taal is node, maar package.json ontbreekt");
    const scripts = JSON.parse(readFileSync(pj, "utf8")).scripts ?? {};
    if (!existsSync(join(map, "node_modules"))) {
      log("node_modules ontbreekt: npm install ...");
      await draai("npm", ["install", "--no-audit", "--no-fund"], { cwd: map, stdio: uitvoer === "stil" ? "ignore" : "inherit" });
    }
    const script = scripts.dev ? "dev" : scripts.start ? "start" : null;
    if (!script) throw new Error("package.json heeft geen script dev of start");
    cmd = "npm"; args = ["run", "--silent", script];
  } else {
    throw new Error(`runtime.taal '${taal}' kan ik niet lokaal starten (alleen python en node)`);
  }
  const kind = spawn(cmd, args, { cwd: map, env, stdio, detached: true });
  kind.on("error", () => {});
  kind.stop = () => stopGroep(kind);
  return kind;
}

/** Stopt een kindproces met alles eronder (SIGTERM, na 2 s SIGKILL). */
export function stopGroep(kind) {
  return new Promise((klaar) => {
    if (!kind || kind.exitCode !== null || kind.signalCode !== null) return klaar();
    const t = setTimeout(() => { try { process.kill(-kind.pid, "SIGKILL"); } catch { /* al weg */ } klaar(); }, 2000);
    kind.once("exit", () => { clearTimeout(t); try { process.kill(-kind.pid, "SIGKILL"); } catch { /* al weg */ } klaar(); });
    try { process.kill(-kind.pid, "SIGTERM"); } catch { clearTimeout(t); klaar(); }
  });
}
