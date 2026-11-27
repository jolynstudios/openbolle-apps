/**
 * Audi-app voor openBolle (TypeScript): bereik, tank of accu, kilometerstand, slot, deuren en ramen, laden en de
 * parkeerplek van je Audi, via myAudi (onofficieel; zie audi.ts). Alleen lezen: op slot doen en de klimaatregeling
 * aanzetten kan nog niet.
 *
 * - De gebruiker vult zijn e-mailadres en wachtwoord van myAudi in (instellingen; het wachtwoord is een geheim).
 *   De app logt daarmee in en bewaart alleen de tokens (opslag:klein). Niets van de gebruiker gaat naar de log.
 * - Zuinig: Audi telt de aanvragen per dag (Vcf-Remaining-Calls) en kan een account bij misbruik blokkeren. Daarom:
 *     * een vraag gebruikt een stand van hooguit 5 minuten oud, de tegel een van hooguit 15 minuten;
 *     * de lijst met auto's wordt één keer opgehaald en onthouden;
 *     * meldt Audi dat er bijna geen aanvragen meer over zijn, dan alleen de bewaarde stand (tot een uur oud);
 *     * een fout wachtwoord wordt niet opnieuw geprobeerd tot de instellingen veranderen (anders blokkeert Audi het
 *       account), en na een andere inlogfout wacht de app 10 minuten;
 *     * de auto wordt nooit gewekt (geen /vehiclewakeup): je ziet wat de auto het laatst aan Audi doorgaf.
 */
import { createHash } from "node:crypto";
import { broker, BrokerFout, kaarten, maakPlugin, waarde, type Argumenten, type Blok, type Context, type ToolResultaat } from "./openbolle.js";
import * as audi from "./audi.js";
import { AlleenFouten, klaarSinds, laadbaar, laadTekst, leesAutos, leesPlek, leesStand, meter, tegelMelding, tegelRegels,
  tegelWaarde, vulling, wanneer, zin, type Stand } from "./stand.js";

const VERS_VRAAG_S = 5 * 60;
const VERS_TEGEL_S = 15 * 60;
const ZUINIG_REST = 20;              // minder aanvragen over dan dit: alleen nog de bewaarde stand
const ZUINIG_S = 60 * 60;
const PAUZE_S = 10 * 60;             // na een inlogfout die niet aan het wachtwoord ligt
const BUDGET_MS = 7000;              // runtime.tijdslimiet_ms is 8000: houd ruimte over

class NietIngesteld extends Error {}
class GeenAuto extends Error {}

interface Sessie extends audi.Tokens { account: string }
interface Auto { account: string; vin: string; naam: string; meer: number }
interface Bewaard extends Stand { account: string; vin: string; naam: string }
interface Rem { rest?: number; restTijd?: number; inlogfout?: { sleutel: string; reden: string; tijd: number } }

const hash = (...x: string[]) => createHash("sha256").update(x.join("\0")).digest("hex").slice(0, 24);

/** Per installatie in het geheugen (sneller dan de opslag; de opslag is de bron als de container opnieuw start). */
const geheugen = new Map<string, Map<string, unknown>>();
const bezig = new Map<string, Promise<Bewaard>>();

async function lees<T>(ctx: Context, sleutel: string): Promise<T | null> {
  const g = geheugen.get(ctx.installatie)?.get(sleutel);
  if (g !== undefined) return g as T;
  try {
    const x = JSON.parse((await broker(ctx).opslag.lees(sleutel)) ?? "null") as T | null;
    if (x !== null) zetGeheugen(ctx, sleutel, x);
    return x;
  } catch { return null; }
}

function zetGeheugen(ctx: Context, sleutel: string, x: unknown): void {
  let m = geheugen.get(ctx.installatie);
  if (!m) geheugen.set(ctx.installatie, (m = new Map()));
  m.set(sleutel, x);
}

async function zet(ctx: Context, sleutel: string, x: unknown): Promise<void> {
  zetGeheugen(ctx, sleutel, x);
  try { await broker(ctx).opslag.zet(sleutel, JSON.stringify(x)); } catch { /* dan alleen in het geheugen */ }
}

async function wis(ctx: Context, sleutel: string): Promise<void> {
  geheugen.get(ctx.installatie)?.delete(sleutel);
  try { await broker(ctx).opslag.wis(sleutel); } catch { /* niets aan te doen */ }
}

// ---------------------------------------------------------------- instellingen en sessie

function instellingen(ctx: Context): { email: string; wachtwoord: string; vin?: string; account: string } {
  const i = ctx.instellingen ?? {};
  const email = typeof i.email === "string" ? i.email.trim() : "";
  const wachtwoord = typeof i.wachtwoord === "string" ? i.wachtwoord : "";
  if (!email || !wachtwoord) throw new NietIngesteld();
  const v = typeof i.vin === "string" ? i.vin.trim().toUpperCase() : "";
  return { email, wachtwoord, vin: /^[A-HJ-NPR-Z0-9]{17}$/.test(v) ? v : undefined, account: hash(email.toLowerCase()) };
}

/** Een geldig toegangstoken: uit de opslag, ververst, of door opnieuw in te loggen. */
async function toegang(ctx: Context, o: audi.Opties, nieuw = false): Promise<string> {
  const ins = instellingen(ctx);
  let s = await lees<Sessie>(ctx, "sessie");
  if (s && s.account !== ins.account) { await wis(ctx, "sessie"); s = null; }   // ander account ingevuld
  if (s && !nieuw && s.verloopt > Date.now()) return s.toegang;
  if (s?.ververs) {
    try {
      const t = await audi.ververs(s, o);
      await zet(ctx, "sessie", { ...t, account: ins.account } satisfies Sessie);
      return t.toegang;
    } catch (e) {
      if (!(e instanceof audi.SessieVerlopen)) throw e;
      await wis(ctx, "sessie");
    }
  }
  // Opnieuw inloggen, maar niet met een wachtwoord dat al fout bleek, en niet vaak na een andere fout.
  const rem = (await lees<Rem>(ctx, "rem")) ?? {};
  const sleutel = hash(ins.email.toLowerCase(), ins.wachtwoord);
  const f = rem.inlogfout;
  if (f && f.sleutel === sleutel && (f.reden === "wachtwoord" || Date.now() - f.tijd < PAUZE_S * 1000)) {
    throw new audi.InlogFout(f.reden as audi.InlogFout["reden"]);
  }
  try {
    const t = await audi.login(ins.email, ins.wachtwoord, o);
    await zet(ctx, "sessie", { ...t, account: ins.account } satisfies Sessie);
    if (f) await zet(ctx, "rem", { ...rem, inlogfout: undefined });
    return t.toegang;
  } catch (e) {
    if (e instanceof audi.InlogFout) await zet(ctx, "rem", { ...rem, inlogfout: { sleutel, reden: e.reden, tijd: Date.now() } });
    throw e;
  }
}

/** Doet `werk` met een token; bij 401 één keer opnieuw met een ververst token. */
async function metToken<T>(ctx: Context, o: audi.Opties, werk: (token: string) => Promise<T>): Promise<T> {
  try {
    return await werk(await toegang(ctx, o));
  } catch (e) {
    if (e instanceof audi.AudiFout && e.status === 401) return await werk(await toegang(ctx, o, true));
    throw e;
  }
}

async function onthoudRest(ctx: Context, rest: number | undefined): Promise<void> {
  if (rest === undefined) return;
  const rem = (await lees<Rem>(ctx, "rem")) ?? {};
  await zet(ctx, "rem", { ...rem, rest, restTijd: Date.now() });
}

/** Welke auto: de VIN uit de instellingen, of de eerste uit myAudi (één keer opgehaald en onthouden). */
async function welkeAuto(ctx: Context, o: audi.Opties): Promise<Auto> {
  const ins = instellingen(ctx);
  const a = await lees<Auto>(ctx, "auto");
  if (a && a.account === ins.account && (!ins.vin || a.vin === ins.vin)) return a;
  const lijst = await metToken(ctx, o, (t) => audi.autos(t, o));
  await onthoudRest(ctx, lijst.rest);
  const alle = leesAutos(lijst.data);
  const gekozen = ins.vin ? alle.find((x) => x.vin === ins.vin) ?? { vin: ins.vin, naam: "je Audi" } : alle[0];
  if (!gekozen) throw new GeenAuto();
  const auto: Auto = { account: ins.account, vin: gekozen.vin, naam: gekozen.naam, meer: ins.vin ? 0 : alle.length - 1 };
  await zet(ctx, "auto", auto);
  return auto;
}

/** De stand van de auto, hooguit maxOud seconden oud. */
async function haal(ctx: Context, maxOud: number): Promise<Bewaard & { oudWantFout?: unknown; zuinig?: boolean }> {
  const ins = instellingen(ctx);
  const vorige = await lees<Bewaard>(ctx, "stand");
  const bruikbaar = vorige && vorige.account === ins.account && (!ins.vin || vorige.vin === ins.vin) ? vorige : null;
  if (bruikbaar && Date.now() - bruikbaar.gekeken < maxOud * 1000) return bruikbaar;
  const rem = (await lees<Rem>(ctx, "rem")) ?? {};
  if (bruikbaar && rem.rest !== undefined && rem.rest < ZUINIG_REST && Date.now() - (rem.restTijd ?? 0) < ZUINIG_S * 1000 &&
      Date.now() - bruikbaar.gekeken < ZUINIG_S * 1000) {
    return { ...bruikbaar, zuinig: true };
  }

  // één ophaalactie tegelijk per installatie (de tegel en een vraag kunnen samenvallen)
  const lopend = bezig.get(ctx.installatie);
  if (lopend) return lopend;
  const p = (async (): Promise<Bewaard> => {
    const o = { deadline: Date.now() + BUDGET_MS };
    const auto = await welkeAuto(ctx, o);
    const a = await metToken(ctx, o, (t) => audi.stand(t, auto.vin, o));
    await onthoudRest(ctx, a.rest);
    const s: Bewaard = { ...leesStand(a.data), account: ins.account, vin: auto.vin, naam: auto.naam };
    s.klaarSinds = klaarSinds(bruikbaar, s);
    await zet(ctx, "stand", s);
    return s;
  })();
  bezig.set(ctx.installatie, p);
  try {
    return await p;
  } catch (e) {
    if (bruikbaar && !(e instanceof NietIngesteld) && !(e instanceof audi.InlogFout)) return { ...bruikbaar, oudWantFout: e };
    throw e;
  } finally {
    bezig.delete(ctx.installatie);
  }
}

// ---------------------------------------------------------------- tekst

const INSTELLEN = "Stel eerst je myAudi-account in: vul bij de app Audi je e-mailadres en wachtwoord van myAudi in.";

function foutTekst(e: unknown): string {
  if (e instanceof NietIngesteld) return INSTELLEN;
  if (e instanceof GeenAuto) return "Ik vind geen auto in je myAudi-account.";
  if (e instanceof audi.InlogFout) {
    switch (e.reden) {
      case "wachtwoord": return "myAudi accepteert je e-mailadres of wachtwoord niet. Controleer ze bij de instellingen van de app Audi.";
      case "geblokkeerd": return "myAudi laat even niet inloggen na te veel pogingen. Probeer het over een tijdje opnieuw.";
      case "stap": return "myAudi vraagt bij het inloggen om een extra stap, bijvoorbeeld nieuwe voorwaarden of een code. Log één keer in met de myAudi-app en probeer het daarna opnieuw.";
      case "captcha": return "myAudi vraagt om een controle die Bolle niet kan doen. Log in met de myAudi-app en probeer het later opnieuw.";
      default: return "Inloggen bij myAudi lukt nu niet. Probeer het later opnieuw.";
    }
  }
  if (e instanceof AlleenFouten) return "Audi geeft nu geen gegevens van je auto. Probeer het later opnieuw.";
  if (e instanceof audi.AudiFout) {
    if (e.status === 403 || e.status === 404) return "Audi geeft geen gegevens van deze auto. Klopt de VIN in de instellingen, en staat de auto in je myAudi-account?";
    if (e.status === 429) return "Even te veel vragen aan Audi. Probeer het later opnieuw.";
    return `Audi is nu niet bereikbaar (${e.status}).`;
  }
  if (e instanceof BrokerFout) return "Even geen verbinding met openBolle.";
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return "Audi antwoordt niet op tijd. Vraag het zo nog eens.";
  return "Audi is nu niet bereikbaar.";
}

const naamVan = (s: { naam: string }) => (s.naam === "je Audi" ? "Je Audi" : s.naam);

function voetnoot(s: Bewaard & { oudWantFout?: unknown; zuinig?: boolean }): string {
  if (s.oudWantFout) return ` (Audi is nu niet bereikbaar; dit is de bewaarde stand${s.tijd ? ` van ${wanneer(s.tijd)}` : ""}.)`;
  if (s.zuinig) return " (Er zijn vandaag bijna geen aanvragen bij Audi meer over; dit is de bewaarde stand.)";
  return s.tijd ? ` De auto gaf dit door om ${wanneer(s.tijd)}.` : "";
}

// ---------------------------------------------------------------- tools en tegel

async function auto_status(ctx: Context): Promise<ToolResultaat> {
  try {
    const s = await haal(ctx, VERS_VRAAG_S);
    const tekst = `${naamVan(s)}: ${zin(s) || "geen gegevens"}.${voetnoot(s)}`;
    if (s.opSlot === false) return { tekst, melding: { titel: "Auto niet op slot", icoon: "car", kleur: "gevaar", geluid: "SFX_MSG" } };
    if (s.ramenOpen.length) return { tekst, melding: { titel: s.ramenOpen.length > 1 ? "Ramen open" : "Raam open", icoon: "car", kleur: "gevaar", geluid: "SFX_MSG" } };
    if (s.deurenOpen.length) return { tekst, melding: { titel: "Deur open", icoon: "car", kleur: "gevaar", geluid: "SFX_MSG" } };
    return tekst;
  } catch (e) {
    return { tekst: foutTekst(e), fout: true };
  }
}

async function laadstatus(ctx: Context): Promise<ToolResultaat> {
  try {
    const s = await haal(ctx, VERS_VRAAG_S);
    if (!laadbaar(s)) {
      return `${naamVan(s)} heeft volgens myAudi geen accu om te laden.` + (s.brandstof !== undefined ? ` De tank is ${s.brandstof}% vol.` : "");
    }
    const delen: string[] = [];
    if (s.soort === "hybrid") { const v = vulling(s); if (v) delen.push(v); }   // tank en accu samen
    else if (s.accu !== undefined) delen.push(`accu ${s.accu}%` + (s.bereikKm !== undefined ? ` (ongeveer ${Math.round(s.bereikKm)} km)` : ""));
    const l = laadTekst(s);
    if (l) delen.push(l);
    if (s.laden?.doel && s.laden.staat !== "charging" && !l?.includes(`${s.laden.doel}%`)) delen.push(`laaddoel ${s.laden.doel}%`);
    return `${naamVan(s)}: ${delen.join(", ") || "geen laadgegevens"}.${voetnoot(s)}`;
  } catch (e) {
    return { tekst: foutTekst(e), fout: true };
  }
}

const plekken = new Map<string, { lat: number; lon: number; tijd: number; rijdt: boolean; gekeken: number }>();   // niet in de opslag

async function waar_staat_mijn_auto(ctx: Context): Promise<ToolResultaat> {
  try {
    const ins = instellingen(ctx);
    let p = plekken.get(ctx.installatie + ins.account);
    let naam = "Je Audi";
    if (!p || Date.now() - p.gekeken > VERS_VRAAG_S * 1000) {
      const o = { deadline: Date.now() + BUDGET_MS };
      const auto = await welkeAuto(ctx, o);
      naam = naamVan(auto);
      const a = await metToken(ctx, o, (t) => audi.parkeerplek(t, auto.vin, o));
      await onthoudRest(ctx, a.rest);
      const x = a.data === null ? null : leesPlek(a.data);
      p = x ? { ...x, rijdt: false, gekeken: Date.now() } : { lat: 0, lon: 0, tijd: 0, rijdt: true, gekeken: Date.now() };
      plekken.set(ctx.installatie + ins.account, p);
    } else {
      const a = await lees<Auto>(ctx, "auto");
      if (a) naam = naamVan(a);
    }
    if (p.rijdt) return `${naam} meldt nu geen parkeerplek. Meestal betekent dat dat de auto rijdt.`;
    const lat = p.lat.toFixed(3), lon = p.lon.toFixed(3);
    return `${naam} staat geparkeerd op ongeveer ${lat}, ${lon} (breedte- en lengtegraad, afgerond op zo'n 100 meter)` +
      (p.tijd ? `, sinds ${wanneer(p.tijd)}` : "") + ". Een straat of plaatsnaam kan ik er niet bij zoeken.";
  } catch (e) {
    return { tekst: foutTekst(e), fout: true };
  }
}

/** Kort, voor het scherm: elke regel past op één regel van Bolle. */
function foutRegels(e: unknown): string[] {
  if (e instanceof NietIngesteld) return ["Nog niet ingesteld", "Vul bij de app Audi je", "myAudi-account in"];
  if (e instanceof GeenAuto) return ["Geen auto in je myAudi-account"];
  if (e instanceof audi.InlogFout) {
    switch (e.reden) {
      case "wachtwoord": return ["myAudi weigert je inlog", "Controleer e-mail en wachtwoord"];
      case "geblokkeerd": return ["myAudi laat even niet inloggen", "Probeer het later opnieuw"];
      case "stap": return ["myAudi vraagt een extra stap", "Log één keer in met de myAudi-app"];
      case "captcha": return ["myAudi vraagt een controle", "Log in met de myAudi-app"];
      default: return ["Inloggen bij myAudi lukt niet", "Probeer het later opnieuw"];
    }
  }
  if (e instanceof AlleenFouten) return ["Audi geeft nu geen gegevens", "Probeer het later opnieuw"];
  if (e instanceof audi.AudiFout) {
    if (e.status === 403 || e.status === 404) return ["Audi geeft geen gegevens", "Klopt de VIN?"];
    if (e.status === 429) return ["Even te veel vragen aan Audi", "Probeer het later opnieuw"];
    return [`Audi nu niet bereikbaar (${e.status})`];
  }
  if (e instanceof BrokerFout) return ["Even geen verbinding", "met openBolle"];
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return ["Audi antwoordt niet op tijd"];
  return ["Audi nu niet bereikbaar"];
}

/**
 * Het scherm op Bolle (BolleOS 1.2): een waarde-scherm, zoals de snelheid. Groot het percentage (accu of tank) met de
 * ring, eronder het bereik; de assistent leest de regels (slot, open, laden, kilometerstand). Een oudere Bolle leest
 * alleen titel, waarde, meter en regels: die staan er ook in. Lukt het niet, dan één kaart met wat er mis is.
 */
async function tegel(ctx: Context): Promise<Blok> {
  try {
    const s = await haal(ctx, VERS_TEGEL_S);
    const regels = tegelRegels(s);
    if (s.oudWantFout || s.zuinig) regels[regels.length - 1] += s.oudWantFout ? " (Audi nu niet bereikbaar)" : " (zuinig: bewaarde stand)";
    const m = meter(s), mld = tegelMelding(s);
    const onder = regels.find((r) => r.length <= 24) ?? "";
    if (!tegelWaarde(s) && m === undefined) {                 // niets om groot te tonen: de regels als kaarten
      return { ...kaarten("Audi", regels.map((t) => ({ titel: t }))), blok: "audi", waarde: "", regels, ...(mld ? { melding: mld } : {}) };
    }
    return { ...waarde("Audi", tegelWaarde(s), { blok: "audi", regel: onder, regels, ...(m !== undefined ? { meter: m } : {}) }),
      ...(mld ? { melding: mld } : {}) };
  } catch (e) {
    const r = foutRegels(e);
    return { ...kaarten("Audi", [{ titel: r[0]!, ...(r[1] ? { tekst: r.slice(1).join(" ") } : {}) }], { blok: "audi" }), waarde: "", regels: r };
  }
}

maakPlugin({
  tools: { auto_status, laadstatus, waar_staat_mijn_auto },
  blokken: { audi: tegel },
});
