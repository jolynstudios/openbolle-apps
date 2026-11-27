/**
 * De stand van een Tesla als tekst en als scherm op Bolle. Alleen rekenen en tekst, geen netwerk: zo is dit te testen
 * (zie test/). plugin.ts haalt de stand op bij Tesla.
 *
 * Het scherm van Bolle (BolleOS 1.2) heeft twee schermen, in de kleur van Tesla:
 *   1. waarde : de accu groot met een ring, het bereik eronder (zoals de snelheid);
 *   2. knoppen: Ververs (nu bij Tesla kijken) en Wekken (een slapende auto wakker maken). Meer kan deze app niet: hij
 *      heeft alleen leesrechten bij Tesla (vehicle_device_data), dus geen slot, klimaat of laden.
 * De assistent leest de regels (tot zes). De waarde staat ook op het beginscherm als "Tesla 52%", dus alleen de accu.
 * Een oudere Bolle (BolleOS 1.1) leest alleen titel, waarde, meter en regels; die staan er ook in.
 */
import { alarm, kaarten, knoppen, waarde, type Blok, type BlokMelding, type Scherm } from "./openbolle.js";

/** De eigen kleur van de app: de ring, de knoppen en de bevestiging. */
export const KLEUR = "#E31937";

/** Wat deze app echt kan na een tik op Bolle (zie actie in plugin.ts). */
export const KNOPPEN: Scherm = knoppen("Tesla", [
  { tekst: "Ververs", actie: "ververs", pictogram: "klok" },
  { tekst: "Wekken", actie: "wekken", pictogram: "auto" },
]);

export interface Stand {
  tijd: number;                      // ms sinds 1970: wanneer de gegevens bij de auto zijn opgehaald
  gekeken?: number;                  // wanneer we het laatst bij Tesla keken (ook als de auto sliep)
  naam: string;
  slaapt: boolean;
  accu?: number;                     // procent
  bereikKm?: number;
  laden?: string;                    // Charging, Complete, Disconnected, Stopped, NoPower, Starting
  vermogenKw?: number;
  volOverMin?: number;
  limiet?: number;
  opSlot?: boolean;
  aanwezig?: boolean;                // is_user_present: zit er iemand in (of bij) de auto
  binnen?: number;
  buiten?: number;
  klimaat?: boolean;
  km?: number;
  klaarSinds?: number;               // ms: wanneer we zagen dat het laden klaar was (na Charging)
}

const MIN = 60_000;
const OUD_VOOR_MELDING = 6 * 60 * MIN;     // een stand ouder dan dit geeft geen melding meer
const KLAAR_MELDING = 2 * 60 * MIN;         // "klaar met laden" blijft zo lang in het blok

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

/** Voor het taalmodel: "laadt met 11 kW, vol over 1 uur 35 min, tot 80%". */
export function laadTekst(s: Stand): string | undefined {
  switch (s.laden) {
    case "Charging": {
      const delen = [s.vermogenKw ? `laadt met ${s.vermogenKw} kW` : "laadt"];
      if (s.volOverMin) delen.push(`vol over ${duur(s.volOverMin)}`);
      if (s.limiet) delen.push(`tot ${s.limiet}%`);
      return delen.join(", ");
    }
    case "Starting": return "begint met laden";
    case "Complete": return s.limiet ? `klaar met laden (${s.limiet}%)` : "klaar met laden";
    case "Stopped": return "aan de lader, laadt niet";
    case "NoPower": return "aan de lader, maar er komt geen stroom";
    case "Disconnected": return "niet aan de lader";
    default: return undefined;
  }
}

/** Kort, voor één regel op het scherm: "Laadt 11 kW, vol om 17:40". Niet aan de lader: niets (dat is gewoon). */
export function laadRegel(s: Stand, nu = Date.now()): string | undefined {
  switch (s.laden) {
    case "Charging": {
      const kw = s.vermogenKw ? `Laadt ${s.vermogenKw} kW` : "Laadt";
      const vol = s.volOverMin ? (s.tijd || nu) + s.volOverMin * MIN : 0;
      return vol > nu ? `${kw}, vol om ${wanneer(vol, nu)}` : kw;      // al voorbij: de stand is oud
    }
    case "Starting": return "Begint met laden";
    case "Complete": return s.limiet ? `Klaar met laden (${s.limiet}%)` : "Klaar met laden";
    case "Stopped": return "Aan de lader, laadt niet";
    case "NoPower": return "Lader geeft geen stroom";
    default: return undefined;
  }
}

export function zin(s: Stand): string {
  const delen: string[] = [];
  if (s.accu !== undefined) delen.push(`accu ${s.accu}%` + (s.bereikKm !== undefined ? ` (ongeveer ${s.bereikKm} km)` : ""));
  const l = laadTekst(s);
  if (l) delen.push(l);
  if (s.opSlot !== undefined) delen.push(s.opSlot ? "op slot" : "niet op slot");
  if (s.binnen !== undefined) delen.push(`binnen ${Math.round(s.binnen)} graden` + (s.klimaat ? " (klimaat staat aan)" : ""));
  return delen.join(", ");
}

/** Na een nieuwe stand: sinds wanneer het laden klaar is (alleen als we het zagen laden), anders undefined. */
export function klaarSinds(vorige: Stand | null | undefined, nieuw: Stand, nu = Date.now()): number | undefined {
  if (nieuw.laden !== "Complete") return undefined;
  if (vorige?.laden === "Complete") return vorige.klaarSinds;
  if (vorige?.laden === "Charging" || vorige?.laden === "Starting") return nu;
  return undefined;
}

/**
 * Een melding uit zichzelf, zolang het speelt (het platform stuurt hem één keer door):
 * - niet op slot terwijl er niemand bij de auto is (Tesla zegt dat met is_user_present);
 * - klaar met laden, als we hem eerst zagen laden (een paar uur lang, met een vaste id).
 * Bij een stand van meer dan een paar uur oud geen melding: dan weten we het niet meer.
 */
export function melding(s: Stand, nu = Date.now()): BlokMelding | undefined {
  if (s.opSlot === false && s.aanwezig === false && s.tijd && nu - s.tijd < OUD_VOOR_MELDING) {
    return alarm("Tesla niet op slot", "car", { kleur: "gevaar", geluid: "SFX_MSG", id: "niet-op-slot" });
  }
  if (s.laden === "Complete" && s.klaarSinds && nu - s.klaarSinds < KLAAR_MELDING) {
    return alarm("Tesla klaar met laden", "bolt", { kleur: "ok", geluid: "SFX_MSG", id: `laden-klaar-${Math.floor(s.klaarSinds / 1000)}` });
  }
  return undefined;
}

/** Het scherm: de accu groot met de ring en het bereik, en de knoppen; de assistent leest ook laden, slot, temperatuur. */
export function tegel(s: Stand, nu = Date.now()): Blok {
  if (s.accu === undefined) {
    const regels = s.slaapt ? ["De auto slaapt", "Nog geen stand bekend", "Vraag Bolle om hem te wekken"] : ["Nog geen stand bekend"];
    const kaart = s.slaapt ? { titel: "De auto slaapt", tekst: "Nog geen stand bekend. Wekken kost een paar cent tegoed." }
      : { titel: "Nog geen stand bekend", tekst: "Tik op Ververs om bij Tesla te kijken" };
    return { titel: "Tesla", waarde: "", regels, blok: "accu", kleur: KLEUR, schermen: [kaarten("Tesla", [kaart]), KNOPPEN] };
  }
  const bereik = s.bereikKm !== undefined ? `${s.bereikKm} km bereik` : undefined;
  const laden = laadRegel(s, nu);
  const slot = s.opSlot === undefined ? undefined : s.opSlot ? "Op slot" : "Niet op slot";
  const temp = s.binnen === undefined ? undefined
    : `Binnen ${Math.round(s.binnen)} °C` + (s.buiten !== undefined ? `, buiten ${Math.round(s.buiten)} °C` : "");
  const km = s.km !== undefined ? `Kilometerstand ${s.km.toLocaleString("nl-NL")} km` : undefined;
  // Slaapt hij, dan is dit de laatst bekende stand: dat hoort vooraan (de assistent leest het), het laden mag dan lager.
  const regels = (s.slaapt
    ? [bereik, slot, `Slaapt, stand van ${wanneer(s.tijd, nu)}`, laden, temp, km]
    : [bereik, laden, slot, temp, km, `Stand van ${wanneer(s.tijd, nu)}`]).filter((x): x is string => !!x);
  const m = melding(s, nu);
  const w = `${s.accu}%`;
  const accu = waarde("Tesla", w, { meter: s.accu, regel: s.slaapt ? "Slaapt" + (bereik ? ` · ${s.bereikKm} km` : "") : bereik ?? laden ?? "" });
  return {
    titel: "Tesla", waarde: w, meter: s.accu, regels: regels.slice(0, 6),   // ook voor een oudere Bolle en het beginscherm
    blok: "accu", kleur: KLEUR, schermen: [accu, KNOPPEN],
    ...(m ? { melding: m } : {}),
  };
}
