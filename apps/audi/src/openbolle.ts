/**
 * Hulpje voor een openBolle-app in TypeScript (protocol 1.0 van het platform). Geen afhankelijkheden: alleen node:http en fetch (Node 22).
 *
 * Een app is een HTTP-server op poort 8080:
 *   POST /mcp        tools/list | tools/call (JSON-RPC). De broker zet "context" in het verzoek.
 *   POST /blok/<id>  het scherm van je app (blok v2, BolleOS 1.2): een van vijf soorten, of tot 4 schermen.
 *                    Maak het met waarde(), kaarten(), vraag(), lijst(), knoppen() of schermen().
 *   POST /actie      het antwoord van Bolle op een vraag, een rij in een lijst of een knop (recht vragen:stellen)
 *   GET  /gezond     200 als alles goed is
 *
 * Gebruik:
 *   import { maakPlugin, waarde } from "./openbolle.js";
 *   maakPlugin({ tools: { hallo: (ctx, args) => `Hallo ${args.naam ?? "daar"}!` },
 *                blokken: { hallo: () => waarde("Hallo", "12:00", { regel: "Dit is je app" }) } });
 *
 * De bron staat in sdk/typescript/src/openbolle.ts van openbolle-apps. Het sjabloon (sjabloon/mijnapp-ts) heeft
 * een kopie, zodat het werkt zonder npm-pakket. Pas de bron aan en kopieer hem daarna; `npm run kopie` in het sjabloon
 * controleert of de kopie nog gelijk is.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

// ---------------------------------------------------------------- typen

/** Instellingen die de gebruiker koos (sleutels uit `instellingen` in app.yaml). */
export type Instellingen = Record<string, unknown>;

/** Plek van Bolle, al afgerond door de broker (locatie:afgerond ca. 1 km, locatie:precies ca. 100 m). */
export interface Locatie {
  lat: number;
  lon: number;
}

/** Wat de broker per aanroep meestuurt. Alleen wat je app mag weten; nooit het apparaat of de gebruiker. */
export interface Context {
  /** Pseudoniem van de installatie. */
  installatie: string;
  instellingen: Instellingen;
  /** Alleen met locatie:afgerond of locatie:precies, en alleen als Bolle weet waar hij is. */
  locatie?: Locatie;
  /** Alleen met rit:status. */
  rijdt?: boolean;
  /** Kortlevend token voor de terugroep-API van de broker (zie broker()). */
  aanroep_token: string;
  taal?: string;
  verzoek_id?: string;
}

/** Argumenten die het taalmodel meegeeft, volgens `parameters` in app.yaml. Controleer ze zelf. */
export type Argumenten = Record<string, unknown>;

/** Een kleur van Bolle voor een alarm: een betekenis, nooit een eigen kleur (zo lijkt een app nooit op een flitser). */
export type AlarmKleur = "info" | "ok" | "gevaar" | "ernstig" | "agenda" | "telefoon";

/** Een eigen kleur: `#RRGGBB`. Alleen voor de ring, knoppen, schakelaars, puntjes, de bevestiging en een bericht. */
export type Hex = `#${string}`;

/**
 * Een alarm op het scherm van Bolle, met geluid (vorm "alarm", de standaard): een gekleurde band bovenin, zoals een
 * flitser. Alleen met het recht `meldingen:sturen`. De namen staan in de naslag van BolleOS (schema/bolleos.json).
 */
export interface Melding {
  vorm?: "alarm";
  /** Kort: hooguit 27 bytes (ongeveer 24 tekens). */
  titel: string;
  /** Naam van een icoon van BolleOS (`check`, `home`, `warn`, …) of een pictogram (`bliksem`, `huis`, …). */
  icoon: string;
  /** Een betekenis van Bolle. Standaard `info`. Een andere kleur laat de broker het alarm weigeren. */
  kleur?: AlarmKleur;
  /** Naam van een geluid van BolleOS, bijvoorbeeld `SFX_MSG`. Weglaten = stil. */
  geluid?: string;
}

/** Een bericht, zoals een WhatsApp-bericht: een balk onderin met de naam van je app en `titel`, daarna in Berichten. */
export interface Bericht {
  vorm: "bericht";
  /** De regel boven het bericht, naast de naam van je app: hooguit 23 bytes. */
  titel: string;
  /** Het bericht zelf, hooguit 70 tekens. */
  tekst?: string;
  /** Eigen kleur van de balk (`#RRGGBB`); standaard de kleur van Bolle. */
  kleur?: Hex;
}

/**
 * Een tekst voor het taalmodel, of een tekst met `fout: true` als het niet lukte (bijvoorbeeld: nog niet gekoppeld).
 * Met `melding` toont Bolle na het antwoord ook een alarm (recht `meldingen:sturen`).
 */
export type ToolResultaat = string | { tekst: string; fout?: boolean; melding?: Melding };

export type ToolHandler = (ctx: Context, args: Argumenten) => ToolResultaat | Promise<ToolResultaat>;

/**
 * Een melding uit zichzelf, in een blok (rechten `blokken:tonen` en `meldingen:sturen`), of bij het antwoord op een
 * actie. Zet hem in het blok zolang het speelt; het platform stuurt elke melding één keer door. Een nieuwe `id` (of
 * zonder `id` een nieuwe titel) is een nieuwe. Maak hem met alarm() of bericht().
 */
export type BlokMelding = (Melding | Bericht) & {
  /** Hooguit 64 tekens. Blijft gelijk zolang het om hetzelfde gaat. */
  id?: string;
};

/** De soorten scherm, elk een kopie van een scherm van Bolle zelf. Zie "Schermen" in de documentatie. */
export type Soort = "waarde" | "kaarten" | "vraag" | "lijst" | "knoppen";

/** Een actie: wat Bolle terugstuurt naar POST /actie. Kleine letters, cijfers en -, hooguit 32 tekens. */
export type ActieNaam = string;

/** Een knop, zoals "Geef eten" bij Ottie. Tik = POST /actie met antwoord "tik" (recht vragen:stellen). */
export interface Knop {
  /** Hooguit 14 tekens (op een knoppen-scherm hooguit 10). */
  tekst: string;
  actie: ActieNaam;
  /** Een pictogram uit app.schema.json (`bliksem`, `slot`, `lamp`, …). */
  pictogram?: string;
}

/** Een kaart, zoals een nieuwsbericht: één per scherm, vegen voor de volgende. */
export interface Kaart {
  /** Hooguit 60 tekens: groot als het in twee regels past, anders kleiner (hooguit drie regels). */
  titel: string;
  /** Hooguit 70 tekens, twee regels. */
  tekst?: string;
  /** Waar het vandaan komt, hooguit 24 tekens, bijvoorbeeld "Wikipedia". */
  bron?: string;
  knop?: Knop;
}

/** Een vraag, zoals "Nog er?": links ja (in je kleur), rechts nee. Het antwoord gaat naar POST /actie. */
export interface Vraag {
  /** Hooguit 60 tekens. */
  tekst: string;
  /** Een regel uitleg, hooguit 60 tekens. */
  uitleg?: string;
  /** Hooguit 10 tekens; standaard "Ja" en "Nee". */
  ja?: string;
  nee?: string;
  actie?: ActieNaam;
}

/** Een rij in een lijst, zoals in het menu: pictogram, tekst, en een waarde of een schakelaar. */
export interface Rij {
  /** Hooguit 24 tekens (met een schakelaar hooguit 10). */
  tekst: string;
  pictogram?: string;
  /** Rechts, hooguit 10 tekens. */
  waarde?: string;
  /** Een schakelaar: aan of uit. Een tik stuurt "aan" of "uit" naar POST /actie. */
  aan?: boolean;
  /** Zonder actie is de rij alleen om te lezen. */
  actie?: ActieNaam;
}

/** Eén scherm. De velden horen bij de soort; zonder soort leidt Bolle hem af (vraag, knoppen, rijen, kaarten, waarde). */
export interface Scherm {
  soort?: Soort;
  /** Klein bovenaan, hooguit 16 tekens. In schermen: standaard de titel van het blok. */
  titel?: string;
  /** waarde: groot in het midden; hooguit 8 tekens als getal (0-9 , . : - / % °), anders 10. */
  waarde?: string;
  /** waarde: klein onder het getal, hooguit 10 tekens (zoals km/u). */
  eenheid?: string;
  /** waarde: één regel eronder, hooguit 24 tekens. */
  regel?: string;
  /** waarde: 0..100, de buitenste ring. */
  meter?: number;
  /** waarde: 0..100, de binnenste ring (lichter). Meer dan twee ringen bestaan niet. */
  meter2?: number;
  /** waarde: één knop onder de inhoud. */
  knop?: Knop;
  /** kaarten: hooguit 8. */
  kaarten?: Kaart[];
  vraag?: Vraag;
  /** lijst: hooguit 6 rijen. */
  rijen?: Rij[];
  /** knoppen: 2 tot 4 vlakken rond het midden (tekst hooguit 10). */
  knoppen?: Knop[];
}

/** Inhoud van het scherm van je app (blok v2). Zie "Schermen" in de documentatie. */
export interface Blok extends Scherm {
  /** Het id van het blok; Bolle stuurt het terug in /actie. */
  blok?: string;
  /** Je eigen kleur, `#RRGGBB`: ring, ja-helft, knoppen, schakelaars, puntjes en bevestiging. Tekst blijft van Bolle. */
  kleur?: Hex;
  /** Tot 6 regels die de assistent voorleest (niet op het scherm). */
  regels?: string[];
  /** Tot 4 schermen; vegen gaat erdoor. Zonder schermen is het blok zelf het scherm. */
  schermen?: Scherm[];
  /** Optioneel: een melding uit zichzelf, zolang het speelt. */
  melding?: BlokMelding;
}

export type BlokHandler = (ctx: Context) => Blok | Promise<Blok>;

/** Wat Bolle stuurt als iemand antwoordt: het blok, de actie en het antwoord. */
export interface Actie {
  blok: string;
  actie: ActieNaam;
  /** "ja"/"nee" bij een vraag, "tik" bij een knop of rij, "aan"/"uit" bij een schakelaar. */
  antwoord: "ja" | "nee" | "tik" | "aan" | "uit";
}

/** Wat Bolle groot laat zien (hooguit 40 tekens), zoals "Garage gaat dicht"; eventueel met een melding. */
export type ActieAntwoord = string | { tekst: string; melding?: BlokMelding };

export type ActieHandler = (ctx: Context, a: Actie) => ActieAntwoord | Promise<ActieAntwoord>;

// ---------------------------------------------------------------- schermen maken

type Rest = Omit<Blok, "soort" | "titel">;

/** Eén groot getal met een ring, zoals de snelheid: waarde("Tesla", "78%", { meter: 78, regel: "312 km bereik" }). */
export function waarde(titel: string, w: string, rest: Rest = {}): Blok {
  return { soort: "waarde", titel, waarde: w, ...rest };
}

/** Kaarten, zoals nieuws: één per scherm, vegen voor de volgende. */
export function kaarten(titel: string, k: Kaart[], rest: Rest = {}): Blok {
  return { soort: "kaarten", titel, kaarten: k, ...rest };
}

/** Een vraag met ja en nee, zoals "Nog er?". Het antwoord komt binnen bij actie. */
export function vraag(titel: string, v: Vraag, rest: Rest = {}): Blok {
  return { soort: "vraag", titel, vraag: v, ...rest };
}

/** Rijen zoals in het menu, met een waarde of een schakelaar. */
export function lijst(titel: string, rijen: Rij[], rest: Rest = {}): Blok {
  return { soort: "lijst", titel, rijen, ...rest };
}

/** 2 tot 4 knoppen rond het midden, zoals Ottie verzorgen. */
export function knoppen(titel: string, k: Knop[], rest: Rest = {}): Blok {
  return { soort: "knoppen", titel, knoppen: k, ...rest };
}

/** Tot 4 schermen, bijvoorbeeld schermen("Tesla", [waarde(...), knoppen(...)], { kleur: "#E31937" }). */
export function schermen(titel: string, s: Scherm[], rest: Omit<Rest, keyof Scherm> = {}): Blok {
  return { titel, schermen: s, ...rest };
}

/** Een alarm, zoals een flitser: alarm("Klaar met laden", "bliksem", { kleur: "ok", geluid: "SFX_MSG", id: "laden-1" }). */
export function alarm(titel: string, icoon: string, o: { kleur?: AlarmKleur; geluid?: string; id?: string } = {}): BlokMelding {
  return { vorm: "alarm", titel, icoon, ...o };
}

/** Een bericht, zoals WhatsApp: bericht("Voordeur", "Er werd aangebeld om 18:02", { id: "bel-1802" }). */
export function bericht(titel: string, tekst?: string, o: { kleur?: Hex; id?: string } = {}): BlokMelding {
  return { vorm: "bericht", titel, ...(tekst !== undefined ? { tekst } : {}), ...o };
}

export interface PluginOpties {
  /** Moet precies gelijk zijn aan de tools in app.yaml. */
  tools: Record<string, ToolHandler>;
  /** Per blok-id uit app.yaml. */
  blokken?: Record<string, BlokHandler>;
  /** Het antwoord van Bolle op een vraag, rij of knop (recht vragen:stellen). Geeft wat Bolle groot laat zien. */
  actie?: ActieHandler;
  /** Standaard 8080, of POORT uit de omgeving (handig om lokaal te testen). */
  poort?: number;
}

// ---------------------------------------------------------------- server

const MAX_BODY = 64 * 1024;

/** Korte naam van een fout, zonder melding of stack (daar kunnen gegevens van gebruikers in staan). */
function foutNaam(e: unknown): string {
  if (e instanceof Error) return e.constructor.name || e.name || "Error";
  return typeof e;
}

function stuur(res: ServerResponse, code: number, obj: unknown): void {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": b.length });
  res.end(b);
}

/** Leest de body, max. 64 KB. Geeft null als hij te groot is. */
function leesBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((klaar, mislukt) => {
    const delen: Buffer[] = [];
    let n = 0;
    let teGroot = false;
    req.on("data", (d: Buffer) => {
      if (teGroot) return;
      n += d.length;
      if (n > MAX_BODY) { teGroot = true; delen.length = 0; } else delen.push(d);
    });
    req.on("end", () => klaar(teGroot ? null : Buffer.concat(delen)));
    req.on("error", mislukt);
  });
}

function alsObject(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}

async function mcp(rq: Record<string, unknown>, tools: Record<string, ToolHandler>): Promise<unknown> {
  const rid = rq.id ?? null;
  const p = alsObject(rq.params);
  if (rq.method === "tools/list") {
    return { jsonrpc: "2.0", id: rid, result: { tools: Object.keys(tools).map((name) => ({ name })) } };
  }
  const naam = typeof p.name === "string" ? p.name : "";
  if (rq.method === "tools/call" && Object.hasOwn(tools, naam)) {
    let tekst: string;
    let fout = false;
    let melding: Melding | undefined;
    try {
      const r = await tools[naam]!(alsObject(rq.context) as unknown as Context, alsObject(p.arguments));
      if (typeof r === "string") tekst = r;
      else { tekst = String(r.tekst); fout = Boolean(r.fout); melding = r.melding; }
    } catch (e) {
      tekst = `Dat lukt nu niet (${foutNaam(e)}).`;
      fout = true;
    }
    return { jsonrpc: "2.0", id: rid, result: { content: [{ type: "text", text: tekst }], isError: fout, ...(melding && !fout ? { melding } : {}) } };
  }
  return { jsonrpc: "2.0", id: rid, error: { code: -32601, message: "onbekend" } };
}

async function behandel(req: IncomingMessage, res: ServerResponse, o: PluginOpties): Promise<void> {
  const pad = (req.url ?? "/").split("?")[0]!;
  if (req.method === "GET") return pad === "/gezond" ? stuur(res, 200, { ok: true }) : stuur(res, 404, {});
  if (req.method !== "POST") return stuur(res, 405, {});
  const blokId = pad.startsWith("/blok/") ? decodeURIComponent(pad.slice(6)) : null;
  const isActie = pad === "/actie" && Boolean(o.actie);
  if (pad !== "/mcp" && !isActie && (blokId === null || !o.blokken || !Object.hasOwn(o.blokken, blokId))) return stuur(res, 404, {});

  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) {
    res.setHeader("Connection", "close");
    return stuur(res, 413, {});
  }
  const body = await leesBody(req);
  if (body === null) return stuur(res, 413, {});
  let rq: Record<string, unknown>;
  try { rq = alsObject(body.length ? JSON.parse(body.toString("utf8")) : {}); } catch {
    return stuur(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "geen geldige JSON" } });
  }

  if (isActie) {
    const a: Actie = { blok: String(rq.blok ?? ""), actie: String(rq.actie ?? ""), antwoord: String(rq.antwoord ?? "tik") as Actie["antwoord"] };
    try {
      const r = await o.actie!(alsObject(rq.context) as unknown as Context, a);
      return stuur(res, 200, typeof r === "string" ? { tekst: r } : { tekst: String(r.tekst ?? ""), ...(r.melding ? { melding: r.melding } : {}) });
    } catch {
      return stuur(res, 200, { tekst: "Dat lukte niet" });
    }
  }
  if (blokId !== null) {
    try {
      const b = await o.blokken![blokId]!(alsObject(rq.context) as unknown as Context);
      return stuur(res, 200, { ...b, titel: b.titel ?? "", waarde: b.waarde ?? "", regels: b.regels ?? [],
        ...(typeof b.meter === "number" ? { meter: Math.max(0, Math.min(100, Math.round(b.meter))) } : {}),
        ...(typeof b.meter2 === "number" ? { meter2: Math.max(0, Math.min(100, Math.round(b.meter2))) } : {}) });
    } catch (e) {
      // lege titel: de broker toont dan de titel uit app.yaml
      return stuur(res, 200, { titel: "", waarde: "", regels: [`Nu niet op te halen (${foutNaam(e)}).`] });
    }
  }
  return stuur(res, 200, await mcp(rq, o.tools));
}

/** Start de app op poort 8080 (of `poort`, of POORT). Logt niets over gebruikers. */
export function maakPlugin(o: PluginOpties): Server {
  const server = createServer((req, res) => {
    behandel(req, res, o).catch(() => { if (!res.headersSent) stuur(res, 500, {}); else res.destroy(); });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.listen(o.poort ?? (Number(process.env.POORT) || 8080), "0.0.0.0");
  // netjes stoppen als Docker het vraagt (node als proces 1 doet dat niet vanzelf)
  for (const s of ["SIGTERM", "SIGINT"] as const) process.once(s, () => { server.close(); process.exit(0); });
  return server;
}

// ---------------------------------------------------------------- terugroep-API van de broker

/** Adres van de broker; het platform zet BROKER_URL in de container. Lokaal: BROKER_URL=http://127.0.0.1:8000 */
export const BROKER_URL = process.env.BROKER_URL ?? "http://plugins:8000";

/** De broker gaf geen 2xx. `status` is de HTTP-code (403: recht ontbreekt, 404: niet gevonden, 413: opslag vol). */
export class BrokerFout extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`broker antwoordde ${status}`);
    this.status = status;
  }
}

export type Params = Record<string, string | number | boolean | undefined | null>;

/**
 * Terugroep-API met het aanroep_token uit de context:
 *   data("verkeer", { soort: "file", n: 8 })   GET /plugin/v1/data/verkeer?...       (recht data:verkeer of data:laadpalen)
 *   opslag.lees/zet/wis("sleutel")             /plugin/v1/opslag/<sleutel>            (recht opslag:klein)
 *   oauthToken()                               GET /plugin/v1/oauth/token             (oauth in app.yaml); null = nog niet gekoppeld
 */
export function broker(ctx: Context, timeoutMs = 3000) {
  function vraag(methode: string, pad: string, body?: string): Promise<Response> {
    return fetch(BROKER_URL + "/plugin/v1" + pad, {
      method: methode,
      headers: {
        Authorization: "Bearer " + ctx.aanroep_token,
        ...(body !== undefined ? { "Content-Type": "application/octet-stream" } : {}),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
  const sleutelPad = (sleutel: string) => "/opslag/" + encodeURIComponent(sleutel);

  return {
    /** Data van het platform, bijvoorbeeld data("laadpalen", { lat, lon, r: 5 }) of data("laadpaal/" + id). */
    async data<T = unknown>(soort: string, params: Params = {}): Promise<T> {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) q.set(k, String(v));
      const pad = "/data/" + soort.split("/").map(encodeURIComponent).join("/") + (q.size ? "?" + q : "");
      const r = await vraag("GET", pad);
      if (!r.ok) throw new BrokerFout(r.status);
      return (await r.json()) as T;
    },
    opslag: {
      /** De waarde, of null als er niets onder die sleutel staat. Sleutel: a-z, 0-9, _ . - (max. 64). */
      async lees(sleutel: string): Promise<string | null> {
        const r = await vraag("GET", sleutelPad(sleutel));
        if (r.status === 404) return null;
        if (!r.ok) throw new BrokerFout(r.status);
        return await r.text();
      },
      async zet(sleutel: string, waarde: string): Promise<void> {
        const r = await vraag("PUT", sleutelPad(sleutel), waarde);
        if (!r.ok) throw new BrokerFout(r.status);
      },
      async wis(sleutel: string): Promise<void> {
        const r = await vraag("DELETE", sleutelPad(sleutel));
        if (!r.ok) throw new BrokerFout(r.status);
      },
    },
    /** Kortlevend token van de gekoppelde dienst, of null als de gebruiker nog niet gekoppeld is. */
    async oauthToken(): Promise<string | null> {
      const r = await vraag("GET", "/oauth/token");
      if (r.status === 409) return null;
      if (!r.ok) throw new BrokerFout(r.status);
      const j = (await r.json()) as { access_token?: string };
      if (!j.access_token) throw new BrokerFout(r.status);
      return j.access_token;
    },
  };
}
