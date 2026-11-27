/**
 * Tesla-app voor openBolle (TypeScript): accu, bereik, laden, slot en temperatuur via de Fleet API van Tesla.
 *
 * - De gebruiker brengt zijn eigen app bij Tesla mee (zie app.yaml, oauth.eigen_app). De broker doet het inloggen;
 *   deze app krijgt per aanroep alleen een kortlevend token (broker(ctx).oauthToken()).
 * - Tesla rekent per aanvraag (de gebruiker heeft $10 gratis tegoed per maand bij Tesla). Daarom:
 *     * een slapende auto wordt nooit vanzelf gewekt, alleen als de gebruiker daarom vraagt;
 *     * de tegel kijkt hooguit eens per 20 minuten bij Tesla (cache per installatie);
 *     * een teller per maand stopt bij MAAND_MAX aanvragen, ruim binnen het gratis tegoed.
 * - Tesla geeft afstanden in mijlen; Bolle toont kilometers.
 */
import { broker, BrokerFout, kaarten, maakPlugin, schermen, type Actie, type Argumenten, type Blok, type Context } from "./openbolle.js";
import { KLEUR, KNOPPEN, klaarSinds, tegel, wanneer, zin, type Stand } from "./tegel.js";

const API = process.env.TESLA_API ?? "https://fleet-api.prd.eu.vn.cloud.tesla.com";   // TESLA_API alleen om lokaal te testen
const MIJL = 1.609344;
const MAAND_MAX = 3000;             // 500 data-aanvragen = $1 bij Tesla: 3000 = $6, binnen het tegoed van $10
const VERS_S = 20 * 60;              // zo vaak hooguit kijkt de tegel bij Tesla (ook als de auto slaapt)
const TIJDSLIMIET_MS = 6500;         // runtime.tijdslimiet_ms is 8000: houd ruimte over

class NietGekoppeld extends Error {}
class TeslaFout extends Error {
  constructor(readonly status: number) { super(`Tesla antwoordde ${status}`); }
}
class TegoedOp extends Error {}

const geheugen = new Map<string, Stand>();   // installatie -> laatste stand (sneller dan de opslag)

// ---------------------------------------------------------------- teller en opslag

function maand(): string {
  return new Date().toISOString().slice(0, 7);
}

async function tel(ctx: Context): Promise<void> {
  const o = broker(ctx).opslag;
  let t = { maand: maand(), n: 0 };
  try {
    const x = JSON.parse((await o.lees("teller")) ?? "null") as typeof t | null;
    if (x && x.maand === t.maand) t = x;
  } catch { /* begin opnieuw */ }
  if (t.n >= MAAND_MAX) throw new TegoedOp();
  t.n++;
  await o.zet("teller", JSON.stringify(t));
}

async function laatste(ctx: Context): Promise<Stand | null> {
  const g = geheugen.get(ctx.installatie);
  if (g) return g;
  try {
    const s = JSON.parse((await broker(ctx).opslag.lees("stand")) ?? "null") as Stand | null;
    if (s) geheugen.set(ctx.installatie, s);
    return s;
  } catch { return null; }
}

async function bewaar(ctx: Context, s: Stand): Promise<void> {
  geheugen.set(ctx.installatie, s);
  try { await broker(ctx).opslag.zet("stand", JSON.stringify(s)); } catch { /* alleen in het geheugen dan */ }
}

// ---------------------------------------------------------------- Tesla

async function tesla(ctx: Context, token: string, pad: string, methode = "GET"): Promise<Record<string, unknown>> {
  await tel(ctx);
  const r = await fetch(API + pad, {
    method: methode,
    headers: { Authorization: "Bearer " + token, Accept: "application/json", "User-Agent": "openBolle-app-tesla/1.0" },
    signal: AbortSignal.timeout(TIJDSLIMIET_MS - 1000),
  });
  if (!r.ok) throw new TeslaFout(r.status);
  const j = (await r.json()) as { response?: unknown };
  return (j.response ?? {}) as Record<string, unknown>;
}

const getal = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});

/** De stand van de auto. Slaapt hij, dan de laatst bekende (met slaapt: true), behalve met wakker = true. */
async function haal(ctx: Context, opties: { vers?: boolean; wakker?: boolean } = {}): Promise<Stand & { wordtWakker?: boolean }> {
  const vorige = await laatste(ctx);
  if (!opties.vers && !opties.wakker && vorige && Date.now() - (vorige.gekeken ?? vorige.tijd) < VERS_S * 1000) return vorige;

  const token = await broker(ctx).oauthToken();
  if (!token) throw new NietGekoppeld();

  const lijst = await tesla(ctx, token, "/api/1/vehicles");
  const auto = obj((Array.isArray(lijst) ? lijst : [])[0]);
  const vin = typeof auto.vin === "string" ? auto.vin : "";
  if (!vin) throw new TeslaFout(404);
  const naam = (typeof auto.display_name === "string" && auto.display_name) || "je Tesla";

  if (auto.state !== "online") {
    if (opties.wakker) {
      await tesla(ctx, token, `/api/1/vehicles/${encodeURIComponent(vin)}/wake_up`, "POST");
      return { ...(vorige ?? { tijd: 0 }), naam, slaapt: true, gekeken: Date.now(), wordtWakker: true };
    }
    const s: Stand = { ...(vorige ?? { tijd: 0 }), naam, slaapt: true, gekeken: Date.now() };
    geheugen.set(ctx.installatie, s);
    return s;
  }

  let d: Record<string, unknown>;
  try {
    d = await tesla(ctx, token, `/api/1/vehicles/${encodeURIComponent(vin)}/vehicle_data?endpoints=${encodeURIComponent("charge_state;climate_state;vehicle_state")}`);
  } catch (e) {
    if (e instanceof TeslaFout && e.status === 408) {           // net in slaap gevallen
      const s: Stand = { ...(vorige ?? { tijd: 0 }), naam, slaapt: true, gekeken: Date.now() };
      geheugen.set(ctx.installatie, s);
      return s;
    }
    throw e;
  }
  const c = obj(d.charge_state), k = obj(d.climate_state), v = obj(d.vehicle_state);
  const bereik = getal(c.battery_range), km = getal(v.odometer);
  const s: Stand = {
    tijd: Date.now(), gekeken: Date.now(), naam, slaapt: false,
    accu: getal(c.battery_level),
    bereikKm: bereik !== undefined ? Math.round(bereik * MIJL) : undefined,
    laden: typeof c.charging_state === "string" ? c.charging_state : undefined,
    vermogenKw: getal(c.charger_power),
    volOverMin: getal(c.minutes_to_full_charge),
    limiet: getal(c.charge_limit_soc),
    opSlot: typeof v.locked === "boolean" ? v.locked : undefined,
    aanwezig: typeof v.is_user_present === "boolean" ? v.is_user_present : undefined,
    binnen: getal(k.inside_temp),
    buiten: getal(k.outside_temp),
    klimaat: typeof k.is_climate_on === "boolean" ? k.is_climate_on : undefined,
    km: km !== undefined ? Math.round(km * MIJL) : undefined,
  };
  s.klaarSinds = klaarSinds(vorige, s);
  await bewaar(ctx, s);
  return s;
}

// ---------------------------------------------------------------- tekst

function foutTekst(e: unknown): string {
  if (e instanceof NietGekoppeld) return "De app Tesla is nog niet gekoppeld. Koppel hem op Bolle: Menu, Apps, Tesla, Koppelen, en scan de QR-code.";
  if (e instanceof TegoedOp) return `Deze maand zijn al ${MAAND_MAX} aanvragen bij Tesla gedaan. Om je Tesla-tegoed te sparen wacht ik tot volgende maand.`;
  if (e instanceof TeslaFout) {
    if (e.status === 401) return "Tesla accepteert de koppeling niet meer. Koppel de app opnieuw op Bolle (Menu, Apps, Tesla).";
    if (e.status === 403) return "Tesla geeft geen toegang. Heb je bij het inloggen toestemming gegeven voor de gegevens van je auto?";
    if (e.status === 404) return "Ik vind geen Tesla bij dit account.";
    if (e.status === 412) return "Tesla vraagt eerst om de app bij hen in orde te maken (domein of betaalgegevens). Zie de uitleg van de app Tesla.";
    if (e.status === 429) return "Even te veel vragen aan Tesla. Probeer het over een paar minuten.";
    return `Tesla is nu niet bereikbaar (${e.status}).`;
  }
  if (e instanceof BrokerFout) return "Even geen verbinding met openBolle.";
  return "Tesla is nu niet bereikbaar.";
}

/** Kort, voor het scherm: elke regel past op één regel van Bolle. */
function foutRegels(e: unknown): string[] {
  if (e instanceof NietGekoppeld) return ["Nog niet gekoppeld", "Koppel eerst: Menu > Apps"];
  if (e instanceof TegoedOp) return [`${MAAND_MAX} aanvragen deze maand`, "Tegoed bij Tesla gespaard", "Volgende maand weer"];
  if (e instanceof TeslaFout) {
    if (e.status === 401) return ["Koppeling verlopen", "Koppel opnieuw: Menu > Apps"];
    if (e.status === 403) return ["Tesla geeft geen toegang", "Koppel opnieuw: Menu > Apps"];
    if (e.status === 404) return ["Geen Tesla in dit account"];
    if (e.status === 412) return ["Je app bij Tesla is niet klaar", "Zie de uitleg van de app"];
    if (e.status === 429) return ["Even te veel vragen aan Tesla", "Probeer het zo opnieuw"];
    return [`Tesla nu niet bereikbaar (${e.status})`];
  }
  if (e instanceof BrokerFout) return ["Even geen verbinding", "met openBolle"];
  return ["Tesla nu niet bereikbaar"];
}

// ---------------------------------------------------------------- tool en scherm

async function status(ctx: Context, args: Argumenten): Promise<string | { tekst: string; fout: boolean }> {
  try {
    const s = await haal(ctx, { vers: true, wakker: args.wakker_maken === true });
    const naam = s.naam === "je Tesla" ? "Je Tesla" : s.naam;
    if (s.wordtWakker) {
      return `Ik maak ${naam} wakker. Dat duurt meestal een halve minuut; vraag het daarna nog eens.` +
        (s.tijd ? ` Laatst bekend (${wanneer(s.tijd)}): ${zin(s)}.` : "");
    }
    if (s.slaapt) {
      const oud = s.tijd && s.accu !== undefined ? ` Laatst bekend (${wanneer(s.tijd)}): ${zin(s)}.` : "";
      return `${naam} slaapt.${oud} Wil je de stand van nu? Dan maak ik hem wakker; dat kost een paar cent van je eigen Tesla-tegoed.`;
    }
    return `${naam}: ${zin(s) || "geen gegevens"}.`;
  } catch (e) {
    return { tekst: foutTekst(e), fout: true };
  }
}

async function accu(ctx: Context): Promise<Blok> {
  try {
    return tegel(await haal(ctx));
  } catch (e) {
    const r = foutRegels(e);
    return { ...schermen("Tesla", [kaarten("Tesla", [{ titel: r[0]!, ...(r[1] ? { tekst: r[1] } : {}) }]), KNOPPEN], { blok: "accu", kleur: KLEUR }),
      waarde: "", regels: r };
  }
}

/**
 * Een tik op Bolle (recht vragen:stellen; nooit tijdens het rijden, dat weigert de broker al). Alleen wat deze app
 * echt kan met zijn leesrechten bij Tesla: nu kijken, of een slapende auto wekken. Antwoord: hooguit 40 tekens.
 */
async function actie(ctx: Context, a: Actie): Promise<string> {
  try {
    if (a.actie === "ververs") {
      const s = await haal(ctx, { vers: true });
      if (s.slaapt) return s.accu !== undefined ? `Slaapt, laatst ${s.accu}%` : "De auto slaapt";
      return s.accu !== undefined ? `Accu ${s.accu}%` + (s.bereikKm !== undefined ? `, ${s.bereikKm} km` : "") : "Bijgewerkt";
    }
    if (a.actie === "wekken") {
      const s = await haal(ctx, { wakker: true });
      return s.wordtWakker ? "Tesla wordt wakker" : "Tesla is al wakker";
    }
    return "Dat kan deze app niet";
  } catch (e) {
    return foutRegels(e)[0]!;
  }
}

maakPlugin({ tools: { status }, blokken: { accu }, actie });
