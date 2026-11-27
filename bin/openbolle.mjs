#!/usr/bin/env node
// openBolle-apps: nieuw, dev, controleer, en voor accessoire-apps en winkels: sleutel, onderteken, winkel, installeer.
// Gebruik: npx github:jolynstudios/openbolle-apps <opdracht>
const [major] = process.versions.node.split(".").map(Number);
if (major < 22) {
  console.error(`Hiervoor is Node 22 of nieuwer nodig (je hebt ${process.versions.node}).`);
  process.exit(1);
}

const { AANROEP, MANIFEST } = await import("../cli/gedeeld.mjs");

const HULP = `openBolle: een app voor Bolle maken, lokaal proberen en controleren.

Gebruik: ${AANROEP} <opdracht>

  nieuw <id> [--taal python|typescript] [--soort server|accessoire]
      Maakt de map ./<id>/ vanuit het sjabloon. Een app (standaard) is code die op het platform draait;
      een accessoire-app is een ondertekend profiel dat op Bolle zelf draait, via Bluetooth.

  dev [map] [--plek lat,lon] [--rijdt] [--poort 4660] [--bolle [poort]] [--site https://…]
      Start de app met een testbroker en opent "Bolle in de browser": tools aanroepen, het blok zien zoals
      Bolle het tekent (scherm of lijst, regel op het beginscherm, melding), plek, rijden en instellingen
      kiezen. --bolle: ook op je eigen Bolle via USB (debugstand). Stoppen: Ctrl-C.

  controleer [map ...] [--contract] [--lokaal]
      Controleert ${MANIFEST} (schema en regels). Zonder map: de app hier, of alle mappen in apps/.
      Let op (geen fout): namen in een melding die BolleOS niet kent, een melding zonder recht.
      --contract start de app ook (in Docker, of lokaal met --lokaal of als Docker er niet is),
      vergelijkt tools/list en de blokken met het manifest en kijkt naar wat elk blok teruggeeft.

Accessoire-apps en je eigen winkel:

  sleutel [publiek.pem] [--sleutel pad]
      Maakt één keer je sleutel (~/.openbolle/winkel-sleutel.pem) en schrijft de publieke sleutel. Toont de code
      van je winkel: die laat Bolle zien bij het toevoegen.

  onderteken [map ...] [--sleutel pad]
      Maakt van profiel.json het ondertekende profiel (dist/profiel.json en .sig). Na elke wijziging.

  controleer [map ...]
      Controleert het ondertekende profiel. Maak daarna je winkel met de volgende opdracht.

  winkel [map] [--controleer] [--dev]
      Maakt winkel.json uit winkel.yaml: de apps in de map zelf en die uit 'bronnen' (je andere repo's, op een
      vaste tag of commit). Zo heeft één maker één winkel. --controleer kijkt alleen of winkel.json bijgewerkt is.

  installeer [map] [--poort pad] [--zonder-handtekening]
      Zet het profiel via USB op je eigen Bolle. Zonder handtekening kan alleen in de debugstand.

De sleutel staat ergens anders? Geef --sleutel pad of zet BOLLE_SLEUTEL.

Voorbeeld:
  ${AANROEP} nieuw mijn-app --taal typescript
  cd mijn-app
  ${AANROEP} dev
`;

const [opdracht, ...args] = process.argv.slice(2);
let code;
switch (opdracht) {
  case undefined: case "-h": case "--help": case "help":
    console.log(HULP); code = 0; break;
  case "nieuw": code = await (await import("../cli/nieuw.mjs")).nieuw(args); break;
  case "dev": code = await (await import("../cli/dev.mjs")).dev(args); break;
  case "controleer": code = await (await import("../cli/controleer.mjs")).controleer(args); break;
  case "sleutel": case "onderteken": case "winkel": case "installeer":
    code = await (await import("../cli/accessoire.mjs"))[opdracht](args); break;
  default:
    console.error(`Onbekende opdracht '${opdracht}'.\n`);
    console.log(HULP); code = 2;
}
process.exitCode = code;
