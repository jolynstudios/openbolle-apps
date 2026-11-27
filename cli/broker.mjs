// Testbroker in Node: speelt de terugroep-API van de broker na, zoals tools/testbroker.py, en (Apparaat, hieronder)
// wat de broker voor Bolle doet: het hoofdblok, de lijst /v1/apps en meldingen uit een blok.
//   GET/PUT/DELETE /plugin/v1/opslag/<sleutel>   opslag in het geheugen (recht opslag:klein)
//   GET /plugin/v1/data/<soort>                   voorbeelddata uit tools/voorbeelddata.json (recht data:*)
//   GET /plugin/v1/oauth/token                    409: lokaal is er nooit een gekoppelde dienst
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { hoofdblok } from "./bolle-usb.mjs";
import { ACTIE, PAKKET, SOORTEN, controleerMelding, kortTekst as kort, leesNamen, leesSchema } from "./gedeeld.mjs";

export { hoofdblok };

const tekens = (s, n) => Array.from(String(s)).slice(0, n).join("");          /* Python: str(x)[:n] */
const pyRound = (x) => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 ? r - 1 : r; };   /* round() van Python */

/* ---- blok v2, zoals blok_v2() en scherm_v2() in broker.py: alleen de velden van BolleOS, ingekort ---- */
const HEX = /^#[0-9A-Fa-f]{6}$/, BLOK_ID = /^[A-Za-z0-9_-]{1,32}$/;
let picto;
const pictoVan = (x) => ((picto ??= new Set(leesSchema().$defs?.pictogram?.enum ?? [])).has(x) ? x : null);
const meterVan = (x) => (typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 100 ? pyRound(x) : null);
const actieVan = (x) => (typeof x === "string" && ACTIE.test(x) ? x : null);
const lijstVan = (x) => (Array.isArray(x) ? x : []);
const isObj = (x) => Boolean(x) && typeof x === "object" && !Array.isArray(x);

function knopVan(x, n, nb) {
  if (!isObj(x)) return null;
  const t = kort(x.tekst, n, nb), a = actieVan(x.actie);
  if (!t || !a) return null;
  return { tekst: t, actie: a, ...(pictoVan(x.pictogram) ? { pictogram: x.pictogram } : {}) };
}

function schermV2(j) {
  const uit = {};
  if (typeof j.foto === "string" && /^[0-9a-f]{24}$/.test(j.foto)) uit.foto = j.foto;
  if (SOORTEN.includes(j.soort)) uit.soort = j.soort;
  for (const [k, n, nb] of [["eenheid", 10, 11], ["regel", 24, 51]]) if (kort(j[k], n, nb)) uit[k] = kort(j[k], n, nb);
  if (meterVan(j.meter2) !== null) uit.meter2 = meterVan(j.meter2);
  const kaarten = [];
  for (const x of lijstVan(j.kaarten)) {
    if (kaarten.length >= 8) break;
    if (!isObj(x) || !kort(x.titel, 60, 63)) continue;
    const k = { titel: kort(x.titel, 60, 63) };
    for (const [f, n, nb] of [["tekst", 70, 75], ["bron", 24, 27]]) if (kort(x[f], n, nb)) k[f] = kort(x[f], n, nb);
    if (knopVan(x.knop, 14, 15)) k.knop = knopVan(x.knop, 14, 15);
    kaarten.push(k);
  }
  if (kaarten.length) uit.kaarten = kaarten;
  const v = j.vraag;
  if (isObj(v) && kort(v.tekst, 60, 71)) {
    const vr = { tekst: kort(v.tekst, 60, 71) };
    for (const [f, n, nb] of [["uitleg", 60, 63], ["ja", 10, 15], ["nee", 10, 15]]) if (kort(v[f], n, nb)) vr[f] = kort(v[f], n, nb);
    if (actieVan(v.actie)) vr.actie = v.actie;
    for (const f of ["ja_pictogram", "nee_pictogram"]) if (pictoVan(v[f])) vr[f] = v[f];
    uit.vraag = vr;
  }
  const rijen = [];
  for (const x of lijstVan(j.rijen)) {
    if (rijen.length >= 6) break;
    if (!isObj(x) || !kort(x.tekst, 24, 27)) continue;
    const r = { tekst: kort(x.tekst, 24, 27) };
    if (kort(x.waarde, 10, 11)) r.waarde = kort(x.waarde, 10, 11);
    if (pictoVan(x.pictogram)) r.pictogram = x.pictogram;
    if (typeof x.aan === "boolean") r.aan = x.aan;
    if (actieVan(x.actie)) r.actie = x.actie;
    rijen.push(r);
  }
  if (rijen.length) uit.rijen = rijen;
  if (knopVan(j.knop, 14, 15)) uit.knop = knopVan(j.knop, 14, 15);
  const knoppen = lijstVan(j.knoppen).map((x) => knopVan(x, 10, 15)).filter(Boolean).slice(0, 4);
  if (knoppen.length >= 2) uit.knoppen = knoppen;
  return uit;
}

/** blok_v2(): de velden van blok v2 naast de oude; v1 (titel, waarde, meter) krijgt die van het eerste waarde-scherm. */
export function blokV2(j, v1) {
  const uit = schermV2(j);
  if (typeof j.blok === "string" && BLOK_ID.test(j.blok)) uit.blok = j.blok;
  if (typeof j.kleur === "string" && HEX.test(j.kleur)) uit.kleur = j.kleur.toUpperCase();
  const schermen = [];
  for (const x of lijstVan(j.schermen)) {
    if (schermen.length >= 4) break;
    if (!isObj(x)) continue;
    const s = schermV2(x);
    if (kort(x.titel, 24, 27)) s.titel = kort(x.titel, 24, 27);
    if (kort(x.waarde, 24, 27)) s.waarde = kort(x.waarde, 24, 27);
    if (meterVan(x.meter) !== null) s.meter = meterVan(x.meter);
    schermen.push(s);
  }
  if (schermen.length) {
    uit.schermen = schermen;
    const w = schermen.find((s) => s.soort === "waarde" && (s.waarde || "meter" in s)) ?? schermen.find((s) => s.waarde);
    if (w && !v1.waarde && !("meter" in v1)) { v1.waarde = w.waarde ?? ""; if ("meter" in w) v1.meter = w.meter; }
  }
  return uit;
}

/**
 * De kant van het apparaat, zoals de echte broker hem doet (bolle/platform/plugins/broker.py: blok_van, blok_melding,
 * melding_van en GET /v1/apps). Eén per dev-sessie: de broker onthoudt per installatie welke melding uit een blok
 * al naar Bolle ging.
 */
export class Apparaat {
  constructor(m, namen = leesNamen()) {
    this.m = m;
    this.namen = namen;
    this.rechten = new Set(m.rechten ?? []);
    this.gezien = null;               /* sleutel van de laatste melding uit een blok (melding_gezien in de broker) */
  }

  /** Vergeet welke melding al gestuurd is (alsof de app opnieuw geïnstalleerd is). */
  vergeet() { this.gezien = null; this.actieGezien = []; }

  /**
   * actie_van_bolle() en actie_melding(): het antwoord van de app op POST /actie zoals Bolle het krijgt. `j` is het ruwe
   * antwoord. Geeft { antwoord: {tekst (≤ 40), naam, melding?}, melding: {melding, nieuw, reden} }. Een melding gaat
   * per id (anders titel) één keer, ook niet als hij al uit het blok kwam.
   */
  actieAntwoord(j) {
    const antwoord = { tekst: kort(j?.tekst, 40, 95), naam: this.m.naam };
    const x = j && typeof j === "object" ? j.melding : undefined;
    if (x === undefined || x === null) return { antwoord, melding: { melding: null, nieuw: false } };
    const k = controleerMelding(x, this.rechten, this.namen);
    if (!k.melding) return { antwoord, melding: { melding: null, nieuw: false, reden: k.reden } };
    const sleutel = x.id !== undefined && x.id !== null ? tekens(x.id, 64) : k.melding.titel;
    this.actieGezien ??= [];
    if (!sleutel || this.actieGezien.includes(sleutel) || this.gezien === sleutel) {
      return { antwoord, melding: { melding: k.melding, nieuw: false, reden: "al gestuurd" } };
    }
    this.actieGezien = [...this.actieGezien, sleutel].slice(-20);
    this.gezien = sleutel;
    antwoord.melding = k.melding;
    return { antwoord, melding: { melding: k.melding, nieuw: true } };
  }

  /**
   * blok_melding(): de melding uit een vers blok gaat één keer naar Bolle. Sleutel: "id" (hooguit 64 tekens), anders de
   * titel. Geen (geldige) melding in het blok: de broker vergeet de vorige, dan mag dezelfde later weer.
   * Geeft { melding (zoals hij naar Bolle gaat, of null), nieuw (gaat hij nu naar Bolle), reden (waarom niet) }.
   */
  meldingUitBlok(j) {
    const x = j && typeof j === "object" ? j.melding : undefined;
    if (x === undefined || x === null) { this.gezien = null; return { melding: null, nieuw: false }; }
    const k = controleerMelding(x, this.rechten, this.namen);
    if (!k.melding) { this.gezien = null; return { melding: null, nieuw: false, reden: k.reden }; }
    const sleutel = x.id !== undefined && x.id !== null ? tekens(x.id, 64) : k.melding.titel;
    if (!sleutel) { this.gezien = null; return { melding: k.melding, nieuw: false, reden: "id is leeg" }; }
    if (this.gezien === sleutel) return { melding: k.melding, nieuw: false, reden: `al gestuurd (${x.id != null ? "zelfde id" : "zelfde titel"})` };
    this.gezien = sleutel;
    return { melding: k.melding, nieuw: true };
  }

  /**
   * blok_van(): het blok zoals Bolle het krijgt. `j` is het ruwe antwoord van de app (null als dat mislukte), `b` het
   * blok uit app.yaml. rijdt: true/false/null (van Bolle zelf). meld: zoals bij de lijst (/v1/apps); alleen dan gaan
   * meldingen mee, en alleen uit het hoofdblok. Geeft { blok (null zonder recht blokken:tonen), melding }.
   */
  blok(b, j, { rijdt = null, meld = false } = {}) {
    if (!b || !this.rechten.has("blokken:tonen")) return { blok: null, melding: { melding: null, nieuw: false } };
    const verborgen = rijdt === true && (b.rijden ?? "volledig") === "verborgen";
    const magMelden = meld && this.rechten.has("meldingen:sturen") && b === hoofdblok(this.m);
    if (verborgen && !magMelden) return { blok: { titel: b.titel, waarde: "", regels: [] }, melding: { melding: null, nieuw: false } };
    const vers = Boolean(j && typeof j === "object" && !Array.isArray(j));
    if (!vers) j = {};
    const uit = {
      titel: tekens(j.titel || b.titel, 24),
      waarde: tekens(j.waarde || "", 24),
      regels: (Array.isArray(j.regels) ? j.regels : []).map((x) => tekens(x, 120)).slice(0, 6),
    };
    const mt = meterVan(j.meter);
    if (mt !== null) uit.meter = mt;
    Object.assign(uit, blokV2(j, uit));
    if (rijdt === true && b.rijden === "eenregel") uit.regels = uit.regels.slice(0, 1);
    let melding = { melding: null, nieuw: false };
    if (meld && vers && b === hoofdblok(this.m)) melding = this.meldingUitBlok(j);
    if (verborgen) return { blok: { titel: uit.titel, waarde: "", regels: [] }, melding };
    return { blok: uit, melding };
  }

  /** Een item van GET /v1/apps: wat Bolle van deze app weet (lijst, beginscherm, meldingen). */
  lijstItem(bl, melding = null) {
    const m = this.m;
    const item = { id: m.id, naam: m.naam, versie: m.versie, kort: m.beschrijving?.kort ?? "", pictogram: m.pictogram,
      waarde: bl?.waarde ?? "", koppelen: Boolean(m.oauth) };       /* lokaal is een app nooit gekoppeld */
    if (bl && "meter" in bl) item.meter = bl.meter;
    if (melding) item.melding = melding;
    if (m.logo) item.logo = m.versie;
    return item;
  }

  /** De regel onder de klok op het beginscherm (om de beurt met de temperatuur), of null als Bolle hem niet toont. */
  thuisRegel(item) {
    if (!item?.waarde || item.koppelen) return null;
    return `${item.naam} ${item.waarde}`;
  }
}

const RECHT_VOOR_DATA = { laadpalen: "data:laadpalen", laadpaal: "data:laadpalen", verkeer: "data:verkeer", flitspalen: "data:verkeer" };

/** Start de testbroker. `rechten`: de rechten uit app.yaml. `log(regel)` krijgt elke aanroep. */
export function startBroker({ poort, rechten = [], log = () => {} }) {
  const token = randomBytes(16).toString("base64url");
  const opslag = new Map();
  const r = new Set(rechten);

  const server = createServer((req, res) => {
    const stuur = (code, body, type = "application/json") => {
      const b = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
      res.writeHead(code, { "Content-Type": type, "Content-Length": b.length });
      res.end(b);
    };
    const pad = (req.url ?? "/").split("?")[0];
    const klaar = (code, body, type) => { log(`${req.method} ${pad} → ${code}`); stuur(code, body, type); };
    if (req.headers.authorization !== "Bearer " + token) return klaar(401, { fout: "token" });

    if (pad.startsWith("/plugin/v1/opslag/")) {
      if (!r.has("opslag:klein")) return klaar(403, { fout: "recht opslag:klein ontbreekt" });
      const sleutel = decodeURIComponent(pad.slice("/plugin/v1/opslag/".length));
      if (req.method === "GET") {
        return opslag.has(sleutel) ? klaar(200, opslag.get(sleutel), "application/octet-stream") : klaar(404, {});
      }
      if (req.method === "PUT") {
        const delen = [];
        req.on("data", (d) => delen.push(d));
        req.on("end", () => { opslag.set(sleutel, Buffer.concat(delen)); klaar(204, ""); });
        return;
      }
      if (req.method === "DELETE") { opslag.delete(sleutel); return klaar(204, ""); }
      return klaar(405, {});
    }
    if (req.method === "GET" && pad.startsWith("/plugin/v1/data/")) {
      const vb = JSON.parse(readFileSync(join(PAKKET, "tools", "voorbeelddata.json"), "utf8"));
      const sleutel = pad.startsWith("/plugin/v1/data/laadpaal/") ? "laadpaal" : pad.split("/").pop();
      const recht = RECHT_VOOR_DATA[sleutel];
      if (recht && !r.has(recht)) return klaar(403, { fout: `recht ${recht} ontbreekt` });
      return sleutel in vb ? klaar(200, vb[sleutel]) : klaar(404, {});
    }
    if (req.method === "GET" && pad === "/plugin/v1/oauth/token") return klaar(409, { fout: "niet gekoppeld (testbroker)" });
    klaar(404, {});
  });
  return new Promise((ok, mislukt) => {
    server.once("error", mislukt);
    server.listen(poort, "127.0.0.1", () => ok({ server, token, opslag }));
  });
}
