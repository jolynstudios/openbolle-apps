/**
 * Sjabloon voor een app in TypeScript (protocol 1.0 van het platform): een HTTP-server op poort 8080 (of POORT uit de omgeving).
 *
 * De broker stuurt per aanroep een JSON-RPC-verzoek naar POST /mcp, met een "context" erbij:
 *   installatie (pseudoniem), instellingen, locatie (alleen met locatie:*), rijdt (alleen met rit:status),
 *   aanroep_token (voor de terugroep-API van de broker; zie broker() in openbolle.ts).
 * Het scherm van je app vraagt de broker op met POST /blok/<id> (blok v2, BolleOS 1.2): zie blokHallo en de helpers
 * waarde(), kaarten(), vraag(), lijst(), knoppen() en schermen() in openbolle.ts.
 * Tikt iemand op een knop, een rij of een antwoord op een vraag, dan komt dat binnen bij actie (recht vragen:stellen).
 * De app bewaart zelf niets (alleen-lezen schijf); gebruik de opslag van de broker als je iets moet onthouden.
 */
import { alarm, maakPlugin, waarde, type Actie, type Argumenten, type Blok, type Context } from "./openbolle.js";

function hallo(ctx: Context, args: Argumenten): string {
  const naam = typeof args.naam === "string" && args.naam ? args.naam : "daar";
  return `Hallo ${naam}!`;
}

/**
 * Het scherm van je app: hier een waarde (de tijd) met een ring en een knop. Probeer ook kaarten(), lijst() of
 * schermen("Hallo", [...]) met meerdere schermen. De limieten staan bij de typen in openbolle.ts; `dev` en
 * `controleer --contract` waarschuwen als iets niet past. Zonder waarde staat je app niet op het beginscherm.
 */
function blokHallo(ctx: Context): Blok {
  const nu = new Date();
  const tijd = nu.toTimeString().slice(0, 5);
  const dag = Math.round((nu.getHours() * 60 + nu.getMinutes()) / 14.4); // hoeveel procent van de dag voorbij is
  const blok = waarde("Hallo", tijd, {
    blok: "hallo",
    meter: dag,
    regel: `${dag}% van de dag`,
    knop: { tekst: "Zeg hallo", actie: "hallo", pictogram: "ster" },
    regels: [`Het is ${tijd}`, `${dag}% van de dag is voorbij`],      // voor de assistent, niet op het scherm
  });
  // Een melding uit zichzelf (rechten blokken:tonen en meldingen:sturen): zet hem in het blok zolang het speelt.
  // Bolle haalt de blokken elke 2 minuten op, ook tijdens het rijden; de broker stuurt elke melding één keer door.
  // Een nieuwe "id" (zonder id: een nieuwe titel) is een nieuwe melding. Namen van iconen en geluiden:
  // schema/bolleos.json. Hier alleen met de instelling proefmelding aan (in dev: Instellingen {"proefmelding": true}).
  if (ctx.instellingen?.proefmelding === true) {
    const uur = nu.toISOString().slice(0, 13).replace(/\D/g, "");
    blok.melding = alarm("Hallo van je app", "bell", { kleur: "info", geluid: "SFX_MSG", id: `proef-${uur}` });
  }
  return blok;
}

/**
 * Een antwoord van Bolle (recht vragen:stellen). Geef terug wat Bolle groot laat zien (hooguit 40 tekens). Komt nooit
 * tijdens het rijden: dan weigert de broker al. Doe alleen wat je app echt kan.
 */
function actie(ctx: Context, a: Actie): string {
  if (a.actie === "hallo") return "Hallo!";
  return "Onbekende actie";
}

maakPlugin({
  tools: { hallo }, // moet precies gelijk zijn aan de tools in het manifest
  blokken: { hallo: blokHallo }, // en dit aan de blokken in het manifest
  actie,
});
