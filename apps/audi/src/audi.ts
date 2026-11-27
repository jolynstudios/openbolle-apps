/**
 * Praten met myAudi (onofficieel): inloggen, token verversen, auto's, stand en parkeerplek.
 *
 * Protocolkennis uit audi_connect_ha (MIT, github.com/audiconnect/audi_connect_ha, audi_services.py). Sinds oktober 2026
 * weigert Audi in Europa het oude inloggen (IDK met wachtwoord, en de device code): de token-stap eist een bewijs van de
 * echte app ("invalid assertion headers"). Wat wel werkt, en wat audi_connect_ha nu in Europa gebruikt, is het inloggen
 * van de myAudi-app bij Auth0 van de VW Group:
 *
 *   1. GET  group.identity.vwgroup.io/authorize   client_id van de myAudi-app, audience https://api.cariad.com,
 *                                                 redirect_uri http://localhost:8080/myaudi-callback, PKCE (S256)
 *   2. de inlogpagina van Auth0 (/u/login): e-mail en wachtwoord
 *   3. Auth0 stuurt door naar de redirect_uri met ?code=...   (die wordt nooit geopend; we lezen alleen de Location)
 *   4. POST group.identity.vwgroup.io/oauth/token  (authorization_code + code_verifier) -> access_token, refresh_token
 *   5. verversen: POST /oauth/token met grant_type refresh_token, audience en scope
 *
 * audi_connect_ha laat de gebruiker stap 2 in een browser doen en het adres van stap 3 terugplakken. Een app heeft
 * geen browser, dus deze app vult het formulier van stap 2 zelf in, met het e-mailadres en wachtwoord uit de
 * instellingen. Met het token van Auth0:
 *   - de lijst met auto's:  POST app-api.live-my.audi.com/vgql/v1/graphql   (userVehicles)
 *   - de stand:             GET  emea.bff.cariad.digital/vehicle/v1/vehicles/<VIN>/selectivestatus?jobs=...
 *   - de parkeerplek:       GET  emea.bff.cariad.digital/vehicle/v1/vehicles/<VIN>/parkingposition   (204 = rijdt)
 * Dit leest alleen wat de auto al naar Audi stuurde; de auto wordt er niet wakker van (dat doet /vehiclewakeup, dat
 * gebruiken we niet).
 */
import { createHash, randomBytes } from "node:crypto";

// Alleen om lokaal te testen met een nagebootste server (test/nep-audi.mjs); op het platform altijd de echte.
const ID = process.env.AUDI_IDENTITY ?? "https://group.identity.vwgroup.io";
const BFF = process.env.AUDI_BFF ?? "https://emea.bff.cariad.digital";
const GRAPHQL = process.env.AUDI_GRAPHQL ?? "https://app-api.live-my.audi.com/vgql/v1/graphql";

// De publieke client van de myAudi-app (vast in audi_connect_ha; de marktinstellingen voor NL geven geen andere).
const CLIENT_ID = "09b6cbec-cd19-4589-82fd-363dfa8c24da@apps_vw-dilab_com";
const AUDIENCE = "https://api.cariad.com";
const SCOPE = "openid profile offline_access";
const TERUG = "http://localhost:8080/myaudi-callback";
const APP_VERSIE = "4.31.0";
const UA = `Android/${APP_VERSIE} (Build 800341641.root project 'myaudi_android'.ext.buildTime) Android/13`;
const JOBS = "access,charging,climatisation,fuelStatus,measurements";

export interface Tokens {
  toegang: string;
  ververs?: string;
  verloopt: number;                  // ms sinds 1970, al met een marge (zie tokens())
}

/** Inloggen lukte niet. reden: wachtwoord (fout e-mail/wachtwoord), geblokkeerd, stap (MFA, voorwaarden), captcha, anders. */
export class InlogFout extends Error {
  constructor(readonly reden: "wachtwoord" | "geblokkeerd" | "stap" | "captcha" | "anders", detail = "") {
    super(`inloggen: ${reden}${detail ? ` (${detail})` : ""}`);
  }
}
/** Het verversen werd geweigerd: opnieuw inloggen. */
export class SessieVerlopen extends Error {}
export class AudiFout extends Error {
  constructor(readonly status: number, readonly waar: string) { super(`${waar}: HTTP ${status}`); }
}

export interface Opties {
  /** Stopt alle aanvragen op dit moment (ms sinds 1970). */
  deadline: number;
}

function signaal(o: Opties, maxMs = 3500): AbortSignal {
  return AbortSignal.timeout(Math.max(200, Math.min(maxMs, o.deadline - Date.now())));
}

function tokens(j: Record<string, unknown>, oud?: string): Tokens {
  const toegang = j.access_token;
  if (typeof toegang !== "string" || !toegang) throw new AudiFout(502, "token");
  const s = typeof j.expires_in === "number" && j.expires_in > 0 ? j.expires_in : 3600;
  // verloopt met marge: 2 minuten, of een kwart van de geldigheid als die kort is
  return { toegang, ververs: typeof j.refresh_token === "string" ? j.refresh_token : oud, verloopt: Date.now() + (s - Math.min(120, s / 4)) * 1000 };
}

async function tokenVerzoek(velden: Record<string, string>, o: Opties): Promise<Record<string, unknown>> {
  const r = await fetch(ID + "/oauth/token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: new URLSearchParams(velden).toString(),
    redirect: "manual",
    signal: signaal(o),
  });
  let j: Record<string, unknown> = {};
  try { j = (await r.json()) as Record<string, unknown>; } catch { /* geen JSON */ }
  if (r.ok && typeof j.access_token === "string") return j;
  const fout = typeof j.error === "string" ? j.error : "";
  if (velden.grant_type === "refresh_token" && (fout === "invalid_grant" || r.status === 401 || r.status === 403)) throw new SessieVerlopen();
  if (fout === "invalid_grant" || fout === "access_denied") throw new InlogFout("anders", fout);
  throw new AudiFout(r.status || 502, "token");
}

/** Nieuw toegangstoken met het refresh-token (Auth0 geeft soms een nieuw refresh-token terug). */
export async function ververs(t: Tokens, o: Opties): Promise<Tokens> {
  if (!t.ververs) throw new SessieVerlopen();
  const j = await tokenVerzoek({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: t.ververs, audience: AUDIENCE, scope: SCOPE }, o);
  return tokens(j, t.ververs);
}

// ---------------------------------------------------------------- inloggen (Auth0 Universal Login)

/** Koekjes van de inlogserver, alleen voor de duur van één keer inloggen. */
class Koekjes {
  private readonly k = new Map<string, string>();
  lees(r: Response): void {
    for (const c of r.headers.getSetCookie()) {
      const kv = c.split(";", 1)[0] ?? "";
      const i = kv.indexOf("=");
      if (i > 0) this.k.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
  kop(): string { return [...this.k].map(([n, v]) => `${n}=${v}`).join("; "); }
}

async function idVraag(url: string, k: Koekjes, o: Opties, body?: URLSearchParams): Promise<Response> {
  const r = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "nl-NL,nl;q=0.9",
      ...(k.kop() ? { Cookie: k.kop() } : {}),
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded", Origin: new URL(ID).origin } : {}),
    },
    body: body?.toString(),
    redirect: "manual",
    signal: signaal(o),
  });
  k.lees(r);
  return r;
}

const absoluut = (loc: string) => new URL(loc, ID).toString();
const isTerug = (loc: string) => loc.startsWith(TERUG);

/** De verborgen velden van het eerste formulier, en of er een wachtwoordveld in staat. */
export function leesFormulier(html: string): { velden: Record<string, string>; wachtwoord: boolean; actie?: string } | null {
  const begin = html.search(/<form\b[^>]*method="post"/i);
  if (begin < 0) return null;
  const eind = html.indexOf("</form>", begin);
  const f = html.slice(begin, eind < 0 ? undefined : eind);
  const velden: Record<string, string> = {};
  for (const m of f.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/type="hidden"/i.test(tag)) continue;
    const naam = /name="([^"]+)"/i.exec(tag)?.[1];
    if (naam) velden[naam] = (/value="([^"]*)"/i.exec(tag)?.[1] ?? "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");
  }
  const actie = /<form\b[^>]*action="([^"]+)"/i.exec(f)?.[1]?.replace(/&amp;/g, "&");
  return { velden, wachtwoord: /<input\b[^>]*name="password"/i.test(f), actie };
}

/** De foutcode op een inlogpagina van Auth0 (data-error-code="wrong-email-credentials" en dergelijke). */
export function foutcode(html: string): string {
  return /data-error-code="([^"]+)"/i.exec(html)?.[1] ?? "";
}

function inlogReden(code: string, html: string): InlogFout {
  if (/wrong|invalid-email|invalid-password|no-db-connection|user-not-found|password-required|email-required/.test(code)) return new InlogFout("wachtwoord", code);
  if (/block|too-many|limit/.test(code)) return new InlogFout("geblokkeerd", code);
  if (/captcha/.test(code) || /name="captcha"/i.test(html)) return new InlogFout("captcha", code);
  return new InlogFout("anders", code || "onbekende fout");
}

/** Zoekt na een POST de weg naar de redirect_uri: volgt redirects binnen de inlogserver (hooguit 6). */
async function volg(r: Response, k: Koekjes, o: Opties): Promise<string> {
  for (let i = 0; i < 6; i++) {
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location") ?? "";
      if (isTerug(loc)) return loc;
      const url = absoluut(loc);
      if (new URL(url).origin !== new URL(ID).origin) throw new InlogFout("anders", "doorgestuurd naar een andere site");
      const pad = new URL(url).pathname;
      // /u/mfa-..., /u/consent, /u/terms...: een extra stap die de gebruiker zelf moet doen
      if (pad.startsWith("/u/") && !pad.startsWith("/u/login")) throw new InlogFout("stap", pad.split("/")[2] ?? "");
      await r.body?.cancel();
      r = await idVraag(url, k, o);
      continue;
    }
    const html = await r.text();
    if (r.status === 400 || r.status === 401 || r.status === 403 || r.status === 429) throw inlogReden(foutcode(html), html);
    throw new InlogFout("stap", `pagina ${new URL(r.url || ID).pathname}`);
  }
  throw new InlogFout("anders", "te veel doorverwijzingen");
}

/** Inloggen met e-mail en wachtwoord. Gooit InlogFout als myAudi ze niet accepteert. */
export async function login(email: string, wachtwoord: string, o: Opties): Promise<Tokens> {
  const k = new Koekjes();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const q = new URLSearchParams({
    client_id: CLIENT_ID, audience: AUDIENCE, redirect_uri: TERUG, response_type: "code", scope: SCOPE,
    code_challenge: challenge, code_challenge_method: "S256", state, ui_locales: "nl-NL",
  });

  // 1. authorize -> /u/login?state=...
  let r = await idVraag(`${ID}/authorize?${q}`, k, o);
  let pagina = "";
  for (let i = 0; i < 4 && r.status >= 300 && r.status < 400; i++) {
    const loc = r.headers.get("location") ?? "";
    if (isTerug(loc)) throw new InlogFout("anders", "geen inlogpagina");
    pagina = absoluut(loc);
    await r.body?.cancel();
    r = await idVraag(pagina, k, o);
  }
  if (r.status !== 200 || !pagina) {
    await r.body?.cancel();
    throw r.status === 429 ? new InlogFout("geblokkeerd", "429") : new AudiFout(r.status, "inlogpagina");
  }
  let html = await r.text();
  let form = leesFormulier(html);
  if (!form) throw new InlogFout("anders", "geen inlogformulier");

  // 2. e-mail en wachtwoord (één pagina), of eerst e-mail en dan wachtwoord (identifier first)
  const post = (f: NonNullable<typeof form>, extra: Record<string, string>) =>
    idVraag(f.actie ? absoluut(f.actie) : pagina, k, o, new URLSearchParams({ ...f.velden, ...extra, action: "default" }));
  if (form.wachtwoord) {
    r = await post(form, { username: email, password: wachtwoord });
  } else {
    r = await post(form, { username: email });
    if (r.status < 300 || r.status >= 400) { html = await r.text(); throw inlogReden(foutcode(html), html); }
    const loc = absoluut(r.headers.get("location") ?? "");
    await r.body?.cancel();
    if (!new URL(loc).pathname.startsWith("/u/login")) throw new InlogFout("stap", new URL(loc).pathname);
    pagina = loc;
    r = await idVraag(pagina, k, o);
    html = await r.text();
    form = leesFormulier(html);
    if (!form?.wachtwoord) throw new InlogFout("anders", "geen wachtwoordveld");
    r = await post(form, { username: email, password: wachtwoord });
  }

  // 3. doorsturen naar http://localhost:8080/myaudi-callback?code=...&state=...
  const terug = new URL(await volg(r, k, o));
  if (terug.searchParams.get("error")) throw new InlogFout("anders", terug.searchParams.get("error") ?? "");
  const code = terug.searchParams.get("code");
  if (!code || terug.searchParams.get("state") !== state) throw new InlogFout("anders", "geen geldige code");

  // 4. code omruilen (PKCE)
  const j = await tokenVerzoek({ client_id: CLIENT_ID, grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: TERUG }, o);
  return tokens(j);
}

// ---------------------------------------------------------------- gegevens

export interface Antwoord<T> {
  data: T | null;                    // null bij 204
  rest?: number;                     // Vcf-Remaining-Calls: hoeveel aanvragen er vandaag nog over zijn (als Audi dat meldt)
}

function kop(token: string): Record<string, string> {
  return {
    Accept: "application/json",
    "Accept-Charset": "utf-8",
    "Accept-Language": "nl-NL",
    "X-App-Name": "myAudi",
    "X-App-Version": APP_VERSIE,
    "X-User-Country": "NL",
    "User-Agent": UA,
    Authorization: "Bearer " + token,
  };
}

async function vraag<T>(url: string, token: string, o: Opties, waar: string, body?: unknown): Promise<Antwoord<T>> {
  const r = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...kop(token), ...(body === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal: signaal(o, 5000),
  });
  const restKop = Number(r.headers.get("vcf-remaining-calls") ?? NaN);
  const rest = Number.isFinite(restKop) ? restKop : undefined;
  if (r.status === 204) return { data: null, rest };
  if (!r.ok) { await r.body?.cancel(); throw new AudiFout(r.status, waar); }
  return { data: (await r.json()) as T, rest };
}

export function autos(token: string, o: Opties): Promise<Antwoord<unknown>> {
  const query = "query vehicleList { userVehicles { vin nickname vehicle { media { shortName longName } } } }";
  return vraag(GRAPHQL, token, o, "auto's", { query });
}

export function stand(token: string, vin: string, o: Opties): Promise<Antwoord<unknown>> {
  return vraag(`${BFF}/vehicle/v1/vehicles/${encodeURIComponent(vin)}/selectivestatus?jobs=${JOBS}`, token, o, "stand");
}

export function parkeerplek(token: string, vin: string, o: Opties): Promise<Antwoord<unknown>> {
  return vraag(`${BFF}/vehicle/v1/vehicles/${encodeURIComponent(vin)}/parkingposition`, token, o, "parkeerplek");
}
