// nieuw: een app beginnen vanuit het sjabloon (Python of TypeScript), of een accessoire-app.
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { maakAccessoire } from "./accessoire.mjs";
import { AANROEP, MANIFEST, PAKKET, leesSchema, manifestNaam } from "./gedeeld.mjs";

const TALEN = {
  python: { map: "mijnapp", naam: "Python", code: "plugin.py", gitignore: "__pycache__/\n*.pyc\n" },
  typescript: { map: "mijnapp-ts", naam: "TypeScript", code: "src/plugin.ts", gitignore: "node_modules/\ndist/\n" },
};

function leesbareNaam(id) {
  const n = id.replace(/-/g, " ").replace(/\s+/g, " ").trim();
  return (n.charAt(0).toUpperCase() + n.slice(1)).slice(0, 16).trim();
}

async function vraagTaal() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question("In welke taal? python of typescript [python]: ")).trim().toLowerCase();
    if (!a || a === "py" || a === "python") return "python";
    if (a === "ts" || a === "typescript") return "typescript";
    return a;
  } finally {
    rl.close();
  }
}

export async function nieuw(args) {
  let taal, soort = "server";
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--taal") taal = args[++i];
    else if (args[i].startsWith("--taal=")) taal = args[i].slice(7);
    else if (args[i] === "--soort") soort = args[++i];
    else if (args[i].startsWith("--soort=")) soort = args[i].slice(8);
    else if (args[i].startsWith("-")) { console.error(`Onbekende optie: ${args[i]}`); return 2; }
    else rest.push(args[i]);
  }
  if (rest.length !== 1) {
    console.error(`Gebruik: ${AANROEP} nieuw <id> [--taal python|typescript] [--soort server|accessoire]`);
    return 2;
  }
  const id = rest[0];
  const patroon = new RegExp(leesSchema().properties.id.pattern);
  if (!patroon.test(id)) {
    console.error(`'${id}' kan geen id zijn: gebruik 3 tot 32 tekens, kleine letters, cijfers en -, beginnend met een letter (bijvoorbeeld: mijn-app).`);
    return 2;
  }
  if (soort !== "server" && soort !== "accessoire") { console.error(`Onbekende soort '${soort}': kies server of accessoire.`); return 2; }
  if (soort === "accessoire") {
    const doel = resolve(id);
    if (existsSync(doel)) { console.error(`De map ${id} bestaat al. Ik overschrijf niets; kies een ander id of verwijder de map eerst.`); return 1; }
    maakAccessoire(doel, id, leesbareNaam(id), join(PAKKET, "sjabloon", "mijnaccessoire"));
    const rel = relative(process.cwd(), doel) || ".";
    console.log(`Klaar: ${rel}/ (accessoire-app, id ${id}).

Zo ga je verder:
  cd ${rel}
  ${AANROEP} sleutel       één keer: je sleutel en de code van je winkel
  ${AANROEP} onderteken    na elke wijziging van profiel.json
  ${AANROEP} controleer    controleer het profiel en de handtekening
  ${AANROEP} winkel        maak winkel.json: dat adres voegen mensen toe op Bolle

Pas profiel.json aan (de app, de woorden en de meldingen) en probeer het in de simulator:
https://openbolle.nl/simulator, tab Accessoire-apps.`);
    return 0;
  }
  if (taal === undefined) taal = process.stdin.isTTY && process.stdout.isTTY ? await vraagTaal() : "python";
  if (taal === "ts") taal = "typescript";
  if (taal === "py") taal = "python";
  const t = TALEN[taal];
  if (!t) { console.error(`Onbekende taal '${taal}': kies python of typescript.`); return 2; }

  const doel = resolve(id);
  if (existsSync(doel)) {
    console.error(`De map ${id} bestaat al. Ik overschrijf niets; kies een ander id of verwijder de map eerst.`);
    return 1;
  }
  const bron = join(PAKKET, "sjabloon", t.map);
  cpSync(bron, doel, {
    recursive: true,
    filter: (p) => !["node_modules", "dist", "__pycache__", ".gitignore"].includes(basename(p)) && !p.endsWith(".pyc"),
  });
  // npm laat .gitignore weg uit een pakket; daarom schrijven we hem zelf
  writeFileSync(join(doel, ".gitignore"), t.gitignore);

  const yamlPad = join(doel, manifestNaam(doel));
  let y = readFileSync(yamlPad, "utf8");
  y = y.replace(/^# Sjabloon:.*\n/, "");
  y = y.replace(/^id:[^\S\n]*\S+/m, (r) => `id: ${id}`.padEnd(r.length));
  y = y.replace(/^naam:[^\S\n]*[^#\n]*?(?=[^\S\n]*(#|$))/m, (r) => `naam: ${leesbareNaam(id)}`.padEnd(r.length));
  writeFileSync(yamlPad, y);

  if (taal === "typescript") {
    for (const f of ["package.json", "package-lock.json"]) {
      const p = join(doel, f);
      if (!existsSync(p)) continue;
      const j = JSON.parse(readFileSync(p, "utf8"));
      j.name = id;
      if (j.packages?.[""]) j.packages[""].name = id;
      writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
    }
  }

  const rel = relative(process.cwd(), doel) || ".";
  console.log(`Klaar: ${rel}/ (app in ${t.naam}, id ${id}).

Zo ga je verder:
  cd ${rel}
  ${AANROEP} dev           probeer hem in de browser (Bolle in de browser)
  ${AANROEP} controleer    kijk of het manifest klopt

Pas ${MANIFEST} aan (auteur, beschrijving, tools, rechten) en schrijf je code in ${t.code}.
De namen van de tools in de code moeten precies gelijk zijn aan de tools in ${MANIFEST}.
Het blok laat zien wat Bolle tekent: een korte waarde, een meter als ring, regels, en een melding uit zichzelf
(zet in dev bij Instellingen {"proefmelding": true}). Meer in README.md.
Indienen: zet de map in apps/${id}/ van een fork van ${AANROEP.replace(/^npx github:/, "github.com/")} en open een pull request.`);
  return 0;
}
