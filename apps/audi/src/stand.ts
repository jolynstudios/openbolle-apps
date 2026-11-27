/**
 * De stand van een Audi uit het antwoord van CARIAD (selectivestatus), en de zinnen die Bolle erover zegt.
 * Alleen rekenen en tekst, geen netwerk: zo is dit te testen met opgenomen antwoorden (zie test/).
 *
 * De veldnamen komen uit audi_connect_ha (MIT, github.com/audiconnect/audi_connect_ha, audi_models.py):
 *   fuelStatus.rangeStatus        carType, totalRange_km, primaryEngine/secondaryEngine {type, currentSOC_pct,
 *                                 currentFuelLevel_pct, remainingRange_km}
 *   measurements.fuelLevelStatus  currentFuelLevel_pct, currentSOC_pct
 *   measurements.odometerStatus   odometer (km)
 *   access.accessStatus           doorLockStatus, overallStatus, doors[{name, status[]}], windows[{name, status[]}]
 *   charging.batteryStatus        currentSOC_pct, cruisingRangeElectric_km
 *   charging.chargingStatus       chargingState, chargePower_kW, remainingChargingTimeToComplete_min
 *   charging.chargingSettings     targetSOC_pct
 *   charging.plugStatus           plugConnectionState, externalPower
 *   climatisation.climatisationStatus  climatisationState
 * Elke waarde heeft een carCapturedTimestamp: wanneer de auto hem het laatst doorgaf.
 */
import type { BlokMelding } from "./openbolle.js";

export interface Motor {
  soort: string;                     // electric, gasoline, diesel, cng, ...
  procent?: number;                  // accu of tank
  bereikKm?: number;
}

export interface Laden {
  staat?: string;                    // chargingState: charging, readyForCharging, notReadyForCharging, chargePurposeReached..., conservation, error
  vermogenKw?: number;
  resterendMin?: number;
  doel?: number;                     // targetSOC_pct
  stekker?: string;                  // plugConnectionState: connected, disconnected
}

export interface Stand {
  tijd: number;                      // ms sinds 1970: de nieuwste carCapturedTimestamp (0 = onbekend)
  gekeken: number;                   // wanneer we het bij Audi vroegen
  soort?: string;                    // carType: electric, hybrid, gasoline, diesel
  bereikKm?: number;
  motoren: Motor[];
  accu?: number;
  brandstof?: number;
  km?: number;
  opSlot?: boolean;
  deurenOpen: string[];
  ramenOpen: string[];
  laden?: Laden;
  klimaat?: string;                  // climatisationState: off, heating, cooling, ventilation
  klaarSinds?: number;               // ms: wanneer we zagen dat het laden klaar was (na charging); zie klaarSinds()
}

export class AlleenFouten extends Error {}

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : {});
const getal = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const tekst = (x: unknown): string | undefined => (typeof x === "string" && x ? x : undefined);
/** De waarde van een job, bv. waarde(d, "fuelStatus", "rangeStatus"). Een job met een fout geeft {}. */
const waarde = (d: Obj, job: string, deel: string): Obj => obj(obj(obj(d[job])[deel]).value);

const NAMEN: Record<string, string> = {
  frontLeft: "linksvoor", frontRight: "rechtsvoor", rearLeft: "linksachter", rearRight: "rechtsachter",
  bonnet: "motorkap", trunk: "achterklep", sunRoof: "schuifdak", sunRoofRear: "schuifdak achter", roofCover: "dak",
};

/** Telt de foutobjecten (een job die {"error": ...} gaf in plaats van een waarde). */
function fouten(x: unknown, diepte = 0): number {
  if (!x || typeof x !== "object" || diepte > 4) return 0;
  let n = 0;
  for (const [k, v] of Object.entries(x as Obj)) n += k === "error" ? 1 : fouten(v, diepte + 1);
  return n;
}

/** Lijst van {name, status[]}: de namen met "open" erin. Onbekend of "unsupported" telt niet als open. */
function open(lijst: unknown): string[] {
  if (!Array.isArray(lijst)) return [];
  const uit: string[] = [];
  for (const x of lijst) {
    const o = obj(x), status = Array.isArray(o.status) ? o.status : [];
    if (typeof o.name === "string" && status.includes("open")) uit.push(NAMEN[o.name] ?? o.name);
  }
  return uit;
}

function slot(toegang: Obj): boolean | undefined {
  const s = toegang.doorLockStatus;
  if (s === "locked") return true;
  if (s === "unlocked") return false;
  // Geen oordeel van de auto zelf: kijk naar de deuren die hij meldt (een coupé heeft er twee, zie audi_connect_ha #861)
  const deuren = (Array.isArray(toegang.doors) ? toegang.doors : []).map(obj)
    .filter((d) => typeof d.name === "string" && d.name !== "bonnet" && Array.isArray(d.status) && !(d.status as unknown[]).includes("unsupported"));
  if (!deuren.length) return undefined;
  return deuren.every((d) => (d.status as unknown[]).includes("locked"));
}

function motor(x: unknown): Motor | undefined {
  const m = obj(x);
  const soort = tekst(m.type);
  if (!soort) return undefined;
  return { soort, procent: getal(m.currentSOC_pct) ?? getal(m.currentFuelLevel_pct), bereikKm: getal(m.remainingRange_km) };
}

/** Maakt een Stand van het antwoord van selectivestatus. Gooit AlleenFouten als er niets bruikbaars in zat. */
export function leesStand(data: unknown, nu = Date.now()): Stand {
  const d = obj(data);
  const bereik = waarde(d, "fuelStatus", "rangeStatus");
  const peil = waarde(d, "measurements", "fuelLevelStatus");
  const teller = waarde(d, "measurements", "odometerStatus");
  const bereik2 = waarde(d, "measurements", "rangeStatus");
  const toegang = waarde(d, "access", "accessStatus");
  const accu = waarde(d, "charging", "batteryStatus");
  const lader = waarde(d, "charging", "chargingStatus");
  const laadinst = waarde(d, "charging", "chargingSettings");
  const stekker = waarde(d, "charging", "plugStatus");
  const klimaat = waarde(d, "climatisation", "climatisationStatus");

  let tijd = 0;
  for (const w of [bereik, peil, teller, bereik2, toegang, accu, lader, stekker, klimaat]) {
    const t = Date.parse(String(w.carCapturedTimestamp ?? ""));
    if (Number.isFinite(t) && t > tijd) tijd = t;
  }

  const motoren = [motor(bereik.primaryEngine), motor(bereik.secondaryEngine)].filter((m): m is Motor => !!m);
  const elektrisch = motoren.find((m) => m.soort === "electric");
  const brandstofMotor = motoren.find((m) => m.soort !== "electric");

  const s: Stand = {
    tijd, gekeken: nu,
    soort: tekst(bereik.carType) ?? tekst(peil.carType),
    bereikKm: getal(bereik.totalRange_km) ?? getal(bereik2.totalRange_km),
    motoren,
    accu: getal(accu.currentSOC_pct) ?? getal(peil.currentSOC_pct) ?? elektrisch?.procent,
    brandstof: getal(peil.currentFuelLevel_pct) ?? brandstofMotor?.procent,
    km: getal(teller.odometer),
    opSlot: slot(toegang),
    deurenOpen: open(toegang.doors),
    ramenOpen: open(toegang.windows),
    klimaat: tekst(klimaat.climatisationState),
  };
  if (Object.keys(lader).length || Object.keys(stekker).length) {
    s.laden = {
      staat: tekst(lader.chargingState),
      vermogenKw: getal(lader.chargePower_kW),
      resterendMin: getal(lader.remainingChargingTimeToComplete_min),
      doel: getal(laadinst.targetSOC_pct),
      stekker: tekst(stekker.plugConnectionState),
    };
  }
  const iets = s.bereikKm !== undefined || s.accu !== undefined || s.brandstof !== undefined || s.km !== undefined ||
    s.opSlot !== undefined || s.laden !== undefined;
  if (!iets && fouten(d) > 0) throw new AlleenFouten("alle onderdelen gaven een fout");
  return s;
}

/** Parkeerplek uit /parkingposition: {data: {lat, lon, carCapturedTimestamp}}. */
export function leesPlek(data: unknown): { lat: number; lon: number; tijd: number } | null {
  const d = obj(obj(data).data);
  const lat = getal(d.lat), lon = getal(d.lon);
  if (lat === undefined || lon === undefined) return null;
  const t = Date.parse(String(d.carCapturedTimestamp ?? ""));
  return { lat, lon, tijd: Number.isFinite(t) ? t : 0 };
}

/** Auto's uit de GraphQL-lijst van myAudi: data.userVehicles[{vin, nickname, vehicle.media.shortName}]. */
export function leesAutos(data: unknown): { vin: string; naam: string }[] {
  const lijst = obj(obj(data).data).userVehicles;
  if (!Array.isArray(lijst)) return [];
  const uit: { vin: string; naam: string }[] = [];
  for (const x of lijst) {
    const o = obj(x);
    const vin = tekst(o.vin);
    if (!vin) continue;
    const media = obj(obj(o.vehicle).media);
    uit.push({ vin: vin.toUpperCase(), naam: tekst(o.nickname) ?? tekst(media.shortName) ?? tekst(media.longName) ?? "je Audi" });
  }
  return uit;
}

// ---------------------------------------------------------------- tekst

const UUR = new Intl.DateTimeFormat("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam" });
const DAG = new Intl.DateTimeFormat("nl-NL", { day: "numeric", month: "short", timeZone: "Europe/Amsterdam" });

export function wanneer(t: number, nu = Date.now()): string {
  const vandaag = DAG.format(new Date(nu)) === DAG.format(new Date(t));
  return vandaag ? UUR.format(new Date(t)) : `${DAG.format(new Date(t))} ${UUR.format(new Date(t))}`;
}

export function duur(min: number): string {
  const u = Math.floor(min / 60), m = Math.round(min % 60);
  return u ? (m ? `${u} uur ${m} min` : `${u} uur`) : `${m} min`;
}

const km = (n: number) => `${Math.round(n).toLocaleString("nl-NL")} km`;

export function opsomming(delen: string[]): string {
  return delen.length <= 1 ? (delen[0] ?? "") : `${delen.slice(0, -1).join(", ")} en ${delen[delen.length - 1]}`;
}

/** Heeft de auto een accu om te laden (elektrisch of plug-in hybride)? */
export function laadbaar(s: Stand): boolean {
  return s.soort === "electric" || s.soort === "hybrid" || s.motoren.some((m) => m.soort === "electric") || !!s.laden?.staat;
}

export function laadTekst(s: Stand): string | undefined {
  const l = s.laden;
  if (!l) return undefined;
  const aan = l.stekker === "connected";
  switch (l.staat) {
    case "charging": {
      const delen = [l.vermogenKw ? `laadt met ${Math.round(l.vermogenKw * 10) / 10} kW` : "laadt"];
      if (l.resterendMin) delen.push(`vol over ${duur(l.resterendMin)}`);
      if (l.doel) delen.push(`tot ${l.doel}%`);
      return delen.join(", ");
    }
    case "chargePurposeReachedAndNotConservationCharging":
    case "chargePurposeReachedAndConservation":
      return l.doel ? `klaar met laden (${l.doel}%)` : "klaar met laden";
    case "conservation": return "klaar met laden, houdt de accu op peil";
    case "error": return "er is een laadfout";
    case "readyForCharging": return aan ? "aan de lader, laadt nu niet" : "niet aan de lader";
    case "notReadyForCharging": return aan ? "aan de lader, maar niet klaar om te laden" : "niet aan de lader";
    default:
      if (l.stekker === "disconnected") return "niet aan de lader";
      if (aan) return "aan de lader";
      return undefined;
  }
}

/** "accu 69% (ongeveer 300 km)" of "tank 63% (ongeveer 540 km)" of bij een plug-in hybride beide. */
export function vulling(s: Stand): string | undefined {
  const delen: string[] = [];
  const elek = s.motoren.find((m) => m.soort === "electric");
  const brand = s.motoren.find((m) => m.soort !== "electric");
  if (s.brandstof !== undefined && s.soort !== "electric") delen.push(`tank ${s.brandstof}%` + (s.soort === "hybrid" && brand?.bereikKm !== undefined ? ` (${km(brand.bereikKm)})` : ""));
  if (s.accu !== undefined && laadbaar(s)) delen.push(`accu ${s.accu}%` + (s.soort === "hybrid" && elek?.bereikKm !== undefined ? ` (${km(elek.bereikKm)} elektrisch)` : ""));
  if (!delen.length) return s.bereikKm !== undefined ? `bereik ongeveer ${km(s.bereikKm)}` : undefined;
  return delen.join(", ") + (s.bereikKm !== undefined ? (s.soort === "hybrid" ? `, samen ongeveer ${km(s.bereikKm)}` : ` (ongeveer ${km(s.bereikKm)})`) : "");
}

/** Wat er open staat: "deur linksvoor", "raam rechtsachter", "achterklep", "schuifdak". */
function openDelen(s: Stand): string[] {
  return [...s.deurenOpen.map((d) => (d === "motorkap" || d === "achterklep" ? d : `deur ${d}`)),
    ...s.ramenOpen.map((r) => (r.startsWith("schuifdak") || r === "dak" ? r : `raam ${r}`))];
}

export function dichtTekst(s: Stand): string | undefined {
  const open = openDelen(s);
  if (open.length) return `open: ${opsomming(open)}`;
  if (s.tijd) return "deuren en ramen dicht";
  return undefined;
}

/** Eén zin voor het taalmodel. */
export function zin(s: Stand): string {
  const delen: string[] = [];
  const v = vulling(s);
  if (v) delen.push(v);
  if (s.opSlot !== undefined) delen.push(s.opSlot ? "op slot" : "niet op slot");
  const d = dichtTekst(s);
  if (d) delen.push(d);
  const l = laadbaar(s) ? laadTekst(s) : undefined;
  if (l) delen.push(l);
  if (s.klimaat && s.klimaat !== "off" && s.klimaat !== "invalid") delen.push("de klimaatregeling staat aan");
  if (s.km !== undefined) delen.push(`kilometerstand ${km(s.km)}`);
  return delen.join(", ");
}

/** Het percentage voor de meter op de tegel: de accu bij een elektrische auto, anders de tank. */
export function meter(s: Stand): number | undefined {
  if (s.soort === "electric") return s.accu;
  return s.brandstof ?? s.accu;
}

/** Groot in het midden van het scherm en op het beginscherm ("Audi 69%"): het percentage bij de ring, anders het
 * bereik. Kort (ca. 10 tekens); niets bekend = leeg (Bolle toont dan een lijst). */
export function tegelWaarde(s: Stand): string {
  const p = meter(s);
  if (p !== undefined) return `${p}%`;
  return s.bereikKm !== undefined ? km(s.bereikKm) : "";
}

export function hoofdletter(t: string): string {
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}

/** Kort, voor één regel op het scherm: "Laadt 11 kW, vol om 10:44". Niet aan de lader: niets (dat is gewoon). */
export function laadRegel(s: Stand, nu = Date.now()): string | undefined {
  const l = s.laden;
  if (!l || !laadbaar(s)) return undefined;
  const aan = l.stekker === "connected";
  switch (l.staat) {
    case "charging": {
      const kw = l.vermogenKw ? `Laadt ${Math.round(l.vermogenKw * 10) / 10} kW`.replace(".", ",") : "Laadt";
      const vol = l.resterendMin ? (s.tijd || nu) + l.resterendMin * 60_000 : 0;
      return vol > nu ? `${kw}, vol om ${wanneer(vol, nu)}` : kw;     // al voorbij: de stand is oud
    }
    case "chargePurposeReachedAndNotConservationCharging":
    case "chargePurposeReachedAndConservation":
      return l.doel ? `Klaar met laden (${l.doel}%)` : "Klaar met laden";
    case "conservation": return "Klaar, houdt de accu op peil";
    case "error": return "Laadfout";
    case "readyForCharging": case "notReadyForCharging": return aan ? "Aan de lader, laadt niet" : undefined;
    default: return aan ? "Aan de lader" : undefined;
  }
}

/**
 * De regels op het scherm. Bolle toont er drie onder de waarde (de assistent leest er zes), dus het belangrijkste eerst:
 * bereik, slot en wat er open staat, laden; dan kilometerstand en de tijd van de stand.
 */
export function tegelRegels(s: Stand, nu = Date.now()): string[] {
  const r: string[] = [];
  const p = meter(s);
  if (s.bereikKm !== undefined && p !== undefined) r.push(`${km(s.bereikKm)} bereik`);   // anders is het bereik de waarde
  if (s.soort === "hybrid" && s.accu !== undefined) {
    const e = s.motoren.find((m) => m.soort === "electric");
    r.push(`Accu ${s.accu}%` + (e?.bereikKm !== undefined ? ` (${km(e.bereikKm)} elektrisch)` : ""));
  }
  const open = openDelen(s);
  if (s.opSlot !== undefined) r.push((s.opSlot ? "Op slot" : "Niet op slot") + (!open.length && s.tijd ? ", alles dicht" : ""));
  if (open.length) r.push(hoofdletter(`open: ${opsomming(open)}`));
  else if (s.opSlot === undefined && s.tijd) r.push("Deuren en ramen dicht");
  const l = laadRegel(s, nu);
  if (l) r.push(l);
  if (s.km !== undefined) r.push(`Kilometerstand ${km(s.km)}`);
  r.push(s.tijd ? `Stand van ${wanneer(s.tijd, nu)}` : "Tijd van de stand onbekend");
  return r.slice(0, 6);
}

const KLAAR = new Set(["chargePurposeReachedAndNotConservationCharging", "chargePurposeReachedAndConservation", "conservation"]);
const KLAAR_MELDING_MS = 2 * 60 * 60_000;    // "klaar met laden" blijft zo lang in het blok

/** Na een nieuwe stand: sinds wanneer het laden klaar is, alleen als we hem eerst zagen laden; anders undefined. */
export function klaarSinds(vorige: Stand | null | undefined, nieuw: Stand, nu = Date.now()): number | undefined {
  if (!KLAAR.has(nieuw.laden?.staat ?? "")) return undefined;
  if (KLAAR.has(vorige?.laden?.staat ?? "")) return vorige!.klaarSinds;
  if (vorige?.laden?.staat === "charging") return nu;
  return undefined;
}

/**
 * Een melding uit zichzelf (in het blok, zolang het speelt; het platform stuurt hem één keer door): klaar met laden,
 * als we hem eerst zagen laden. Niet op slot of een raam open meldt de app alleen bij een vraag: of de auto rijdt of
 * geparkeerd staat, weet hij niet zonder de parkeerplek op te halen.
 */
export function tegelMelding(s: Stand, nu = Date.now()): BlokMelding | undefined {
  if (s.klaarSinds && KLAAR.has(s.laden?.staat ?? "") && nu - s.klaarSinds < KLAAR_MELDING_MS) {
    return { id: `laden-klaar-${Math.floor(s.klaarSinds / 1000)}`, titel: "Audi klaar met laden", icoon: "bolt", kleur: "ok", geluid: "SFX_MSG" };
  }
  return undefined;
}
