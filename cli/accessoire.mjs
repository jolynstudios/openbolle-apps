// Accessoire-apps (een ondertekend profiel dat op Bolle zelf draait) en winkels: sleutel, onderteken, winkel,
// installeer, en de controle van een profiel. Alles met wat Node al heeft (crypto, git via de opdrachtregel).
// De grenzen hieronder zijn die van BolleOS (firmware/bolleos/main/accessoire/accessoire.h en winkels.c).
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import { AANROEP, MANIFEST, appMappen, heeftAppMap, heeftManifest, leesManifest, leesNamen, manifestNaam } from "./gedeeld.mjs";

const MAX = { regels: 16, negeer: 8, bevat: 4, varianten: 4, kenmerken: 12, kleuren: 24, demo: 16, btNaam: 20 };
const MAX_PROFIEL = 16 * 1024;         // zo groot mag een profiel zijn dat Bolle uit een winkel haalt
const MAX_INDEX = 48 * 1024;           // en zo groot winkel.json
const MAX_IN_WINKEL = 16;              // accessoire-apps die Bolle uit alle winkels samen toont
const ID = /^[a-z][a-z0-9_-]{1,30}$/;
const STANDAARD_SLEUTEL = join(homedir(), ".openbolle", "winkel-sleutel.pem");

const leesYaml = (pad) => YAML.parse(readFileSync(pad, "utf8")) ?? {};
const posix = (p) => p.split(sep).join("/");

/** De code die Bolle laat zien bij het vertrouwen van een winkel: "d2ec 24f7 9baf 873e". */
export function vinger(publiekPem) {
  const der = createPublicKey(publiekPem).export({ type: "spki", format: "der" });
  const h = createHash("sha256").update(der).digest("hex");
  return [0, 4, 8, 12].map((i) => h.slice(i, i + 4)).join(" ");
}

/** De bytes die ondertekend worden en naar Bolle gaan: het profiel zonder witruimte. */
export function compact(profiel) { return Buffer.from(JSON.stringify(profiel), "utf8"); }

function priveSleutelPad(args) {
  const i = args.indexOf("--sleutel");
  if (i >= 0) return resolve(args[i + 1] ?? "");
  return process.env.BOLLE_SLEUTEL ? resolve(process.env.BOLLE_SLEUTEL) : STANDAARD_SLEUTEL;
}
const zonderOpties = (args, metWaarde = ["--sleutel", "--poort"]) => args.filter((a, i) => !a.startsWith("-") && !metWaarde.includes(args[i - 1]));

/** De publieke sleutel van de winkel bij een app: winkel.yaml (sleutel:) in de map of die erboven, anders publiek.pem. */
function publiekeSleutel(map) {
  for (const m of [map, dirname(resolve(map)), dirname(dirname(resolve(map)))]) {
    const wy = join(m, "winkel.yaml");
    if (existsSync(wy)) { const s = leesYaml(wy).sleutel; if (s && existsSync(join(m, s))) return readFileSync(join(m, s), "utf8"); }
    for (const n of ["publiek.pem", "tools/publiek.pem"]) if (existsSync(join(m, n))) return readFileSync(join(m, n), "utf8");
  }
  return null;
}

/* ---------- controleren ---------- */

/** Fouten in een profiel (leeg = goed). Dezelfde grenzen als BolleOS; de simulator op de site leest het met de echte code. */
export function profielFouten(p, namen = leesNamen()) {
  const f = [];
  const tekst = (o, k, waar) => { if (typeof o?.[k] !== "string" || !o[k]) f.push(`${waar}${k} ontbreekt`); };
  if (!p || typeof p !== "object" || Array.isArray(p)) return ["profiel.json is geen object"];
  if (p.profiel !== 1) f.push("profiel moet 1 zijn (de versie van het formaat)");
  if (typeof p.id !== "string" || !ID.test(p.id)) f.push("id: kleine letters, cijfers, - en _, hooguit 31 tekens");
  for (const k of ["naam", "versie"]) tekst(p, k, "");
  if (typeof p.versie === "string" && !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(p.versie)) f.push(`versie '${p.versie}': gebruik groot.klein.reparatie, bijvoorbeeld 1.0.0 (Bolle vergelijkt de getallen en gaat nooit terug naar een lagere)`);
  const bt = p.bluetooth;
  if (!bt || typeof bt !== "object") f.push("bluetooth ontbreekt");
  else {
    for (const k of ["naam", "fabrikant", "model", "serienummer", "firmware", "software", "dienst"]) tekst(bt, k, "bluetooth.");
    if (typeof bt.naam === "string" && Buffer.byteLength(bt.naam) > MAX.btNaam) f.push(`bluetooth.naam te lang (hooguit ${MAX.btNaam} tekens)`);
    if (typeof bt.software === "string" && /^v?\d+(\.\d+)*$/.test(bt.software.trim())) f.push("bluetooth.software mag geen los versienummer zijn: sommige apps willen het accessoire dan bijwerken");
    const k = bt.kenmerken;
    if (!Array.isArray(k) || !k.length) f.push("bluetooth.kenmerken: minstens één");
    else if (k.length > MAX.kenmerken) f.push(`bluetooth.kenmerken: hooguit ${MAX.kenmerken}`);
  }
  if (Array.isArray(p.kleuren) && p.kleuren.length > MAX.kleuren) f.push(`kleuren: hooguit ${MAX.kleuren}`);
  if (Array.isArray(p.demo) && p.demo.length > MAX.demo) f.push(`demo: hooguit ${MAX.demo}`);
  for (const [i, k] of (Array.isArray(p.kleuren) ? p.kleuren : []).entries()) {
    if (k.icoon && !namen.iconen.includes(k.icoon)) f.push(`kleuren[${i}]: onbekend icoon: ${k.icoon}`);
    if (k.clip && !namen.geluiden.includes(k.clip)) f.push(`kleuren[${i}]: onbekend geluid: ${k.clip}`);
  }
  const m = p.meldingen;
  if (m !== undefined) {
    if (typeof m?.app !== "string" || m.app.length < 4) f.push("meldingen.app: minstens 4 tekens van de app-id");
    if (Array.isArray(m?.negeer) && m.negeer.length > MAX.negeer) f.push(`meldingen.negeer: hooguit ${MAX.negeer} woorden`);
    const r = Array.isArray(m?.regels) ? m.regels : [];
    if (r.length > MAX.regels) f.push(`meldingen.regels: hooguit ${MAX.regels}`);
    for (const [i, x] of r.entries()) {
      const b = Array.isArray(x.bevat) ? x.bevat : [];
      if (!b.length) f.push(`meldingen.regels[${i}]: 'bevat' ontbreekt`);
      if (b.length > MAX.bevat) f.push(`meldingen.regels[${i}] (${x.titel ?? "?"}): hooguit ${MAX.bevat} woorden in bevat; maak een tweede regel met dezelfde titel`);
      if (Array.isArray(x.varianten) && x.varianten.length > MAX.varianten) f.push(`meldingen.regels[${i}]: hooguit ${MAX.varianten} varianten`);
      if (typeof x.titel !== "string" || !x.titel) f.push(`meldingen.regels[${i}]: titel ontbreekt`);
    }
  }
  const n = compact(p).length;
  if (n > MAX_PROFIEL) f.push(`profiel te groot (${n} bytes, hooguit ${MAX_PROFIEL})`);
  return f;
}

/** Fouten voor een map met een accessoire-app (app.yaml met soort: accessoire). */
export function accessoireFouten(map, m, { getekend = true } = {}) {
  const pid = m.id ?? basename(resolve(map));
  const f = [];
  const fout = (t) => f.push(`${pid}: ${t}`);
  if (m.manifest !== 1) fout("manifest moet 1 zijn");
  if (typeof m.id !== "string" || !ID.test(m.id)) fout("id: kleine letters, cijfers, - en _, hooguit 31 tekens");
  for (const k of ["naam", "versie"]) if (!m[k]) fout(`'${k}' ontbreekt`);
  if (!m.auteur?.naam) fout("auteur.naam ontbreekt");
  if (!m.beschrijving?.kort) fout("beschrijving.kort ontbreekt");
  else if (String(m.beschrijving.kort).length > 80) fout("beschrijving.kort te lang (hooguit 80 tekens)");
  for (const k of ["profiel", "handtekening"]) if (typeof m[k] !== "string" || !m[k]) fout(`'${k}' ontbreekt (het pad naar het ondertekende profiel, bijvoorbeeld dist/profiel.json)`);
  for (const k of ["rechten", "tools", "blokken", "runtime", "netwerk"]) if (m[k] !== undefined) fout(`'${k}' hoort bij een app, niet bij een accessoire-app`);
  if (m.logo && !existsSync(join(map, m.logo))) fout(`logo ${m.logo} ontbreekt`);
  for (const a of m.presentatie?.afbeeldingen ?? []) if (!existsSync(join(map, a.bestand))) fout(`afbeelding ${a.bestand} ontbreekt`);
  if (m.presentatie?.documentatie && !existsSync(join(map, m.presentatie.documentatie))) fout(`documentatie ${m.presentatie.documentatie} ontbreekt`);
  const bron = join(map, "profiel.json");
  let p = null;
  if (existsSync(bron)) {
    try { p = JSON.parse(readFileSync(bron, "utf8")); } catch (e) { fout(`profiel.json is geen geldige JSON: ${e.message}`); }
    if (p) for (const x of profielFouten(p)) fout(`profiel.json: ${x}`);
    if (p && p.id !== m.id) fout(`profiel.json heeft id '${p.id}', ${manifestNaam(map)} '${m.id}': die moeten gelijk zijn`);
    if (p && String(p.versie) !== String(m.versie)) fout(`profiel.json heeft versie ${p.versie}, ${manifestNaam(map)} ${m.versie}: die moeten gelijk zijn`);
  } else if (!getekend) fout("profiel.json ontbreekt");
  if (f.length || !getekend || typeof m.profiel !== "string") return f;
  const uit = join(map, m.profiel), sig = join(map, m.handtekening);
  if (!existsSync(uit) || !existsSync(sig)) { fout(`nog niet ondertekend (${m.profiel} of ${m.handtekening} ontbreekt): voer eerst onderteken uit met ${AANROEP} onderteken`); return f; }
  const data = readFileSync(uit);
  let q;
  try { q = JSON.parse(data.toString("utf8")); } catch { fout(`${m.profiel} is geen geldige JSON`); return f; }
  for (const x of profielFouten(q)) fout(`${m.profiel}: ${x}`);
  if (q.id !== m.id || String(q.versie) !== String(m.versie)) fout(`${m.profiel} is van ${q.id} ${q.versie}, ${manifestNaam(map)} zegt ${m.id} ${m.versie}: onderteken opnieuw`);
  if (p && !compact(p).equals(compact(q))) fout(`${m.profiel} is ouder dan profiel.json: onderteken opnieuw`);
  const pem = publiekeSleutel(map);
  if (!pem) fout("geen publieke sleutel gevonden (winkel.yaml met sleutel:, of publiek.pem)");
  else if (!verify("sha256", data, pem, readFileSync(sig))) fout(`de handtekening klopt niet met de publieke sleutel van de winkel (${vinger(pem)})`);
  return f;
}

/* ---------- sleutel ---------- */

export async function sleutel(args) {
  const pad = priveSleutelPad(args);
  const doel = resolve(zonderOpties(args)[0] ?? "publiek.pem");
  let publiek;
  if (existsSync(pad)) {
    publiek = createPublicKey(readFileSync(pad)).export({ type: "spki", format: "pem" });
    console.log(`Je hebt al een sleutel: ${pad}`);
  } else {
    const k = generateKeyPairSync("ec", { namedCurve: "P-256" });
    mkdirSync(dirname(pad), { recursive: true });
    writeFileSync(pad, k.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    chmodSync(pad, 0o600);
    publiek = k.publicKey.export({ type: "spki", format: "pem" });
    console.log(`Nieuwe sleutel gemaakt: ${pad}`);
  }
  if (!existsSync(doel) || readFileSync(doel, "utf8") !== publiek) writeFileSync(doel, publiek);
  console.log(`Publieke sleutel: ${relative(process.cwd(), doel) || doel}  (zet dit pad bij 'sleutel:' in winkel.yaml)

Code van je winkel: ${vinger(publiek)}
Zet deze code op de plek waar mensen je winkel vinden. Bolle laat hem zien bij het toevoegen, en zij vergelijken.

Bewaar ${pad} goed en geef hem nooit weg: wie hem heeft, kan apps uitbrengen onder jouw naam.
Zet hem niet in een repo. Raak je hem kwijt, dan moet iedereen je winkel opnieuw toevoegen.`);
  return 0;
}

/* ---------- onderteken ---------- */

export function ondertekenMap(map, priveSleutel) {
  const m = leesManifest(map);
  if (m.soort !== "accessoire") throw new Error("dit is geen accessoire-app (soort: accessoire); een app met code onderteken je niet");
  const f = accessoireFouten(map, m, { getekend: false });
  if (f.length) throw new Error("eerst dit oplossen:\n  - " + f.join("\n  - "));
  const data = compact(JSON.parse(readFileSync(join(map, "profiel.json"), "utf8")));
  const sig = sign("sha256", data, priveSleutel);
  const pem = publiekeSleutel(map);
  if (pem && !verify("sha256", data, pem, sig)) throw new Error(`deze sleutel hoort niet bij de publieke sleutel van de winkel (${vinger(pem)})`);
  for (const [pad, inhoud] of [[m.profiel, data], [m.handtekening, sig]]) { mkdirSync(dirname(join(map, pad)), { recursive: true }); writeFileSync(join(map, pad), inhoud); }
  return { m, bytes: data.length, sig: sig.length, vinger: vinger(createPublicKey(priveSleutel).export({ type: "spki", format: "pem" })) };
}

export async function onderteken(args) {
  const pad = priveSleutelPad(args);
  if (!existsSync(pad)) { console.error(`Geen sleutel gevonden (${pad}). Maak er een met: ${AANROEP} sleutel`); return 1; }
  const mappen = zonderOpties(args);
  try {
    for (const map of mappen.length ? mappen : ["."]) {
      const r = ondertekenMap(map, readFileSync(pad));
      console.log(`${r.m.id} ${r.m.versie}: ${r.m.profiel} (${r.bytes} bytes) ondertekend met ${r.vinger}`);
    }
  } catch (e) { console.error(e.message); return 1; }
  return 0;
}

/* ---------- winkel ---------- */

const git = (args, cwd) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();

/** Haalt een bron op (repo op een vaste tag of commit) en geeft { map, commit } terug. */
function haalBron(b, tmp, dev) {
  if (b.pad) {
    if (!dev) throw new Error(`bron '${b.pad}' is een map op je eigen computer: dat mag alleen met --dev. Een winkel die je uitbrengt wijst naar een repo met een tag of commit.`);
    return { wortel: resolve(b.pad), map: resolve(b.pad, b.map ?? "."), commit: null };
  }
  if (typeof b.repo !== "string" || !/^https:\/\//.test(b.repo)) throw new Error(`bron zonder 'repo' (https://…): ${JSON.stringify(b)}`);
  if (!b.tag && !b.commit && !(dev && b.tak)) throw new Error(`${b.repo}: geef een 'tag' of 'commit' op. Een tak verandert; een winkel moet elke keer hetzelfde opleveren.`);
  const doel = mkdtempSync(join(tmp, "bron-"));
  try {
    if (b.commit) { git(["init", "-q"], doel); git(["fetch", "-q", "--depth", "1", b.repo, b.commit], doel); git(["checkout", "-q", "FETCH_HEAD"], doel); }
    else git(["clone", "-q", "--depth", "1", "--branch", b.tag ?? b.tak, b.repo, "."], doel);
  } catch (e) { throw new Error(`${b.repo} (${b.commit ?? b.tag ?? b.tak}) ophalen lukt niet: ${String(e.stderr || e.message).trim().split("\n").pop()}`); }
  return { wortel: doel, map: join(doel, b.map ?? "."), commit: git(["rev-parse", "HEAD"], doel) };
}

/** De bestanden van een app die in de winkel horen (relatief aan de map `d` van de app). */
function winkelBestanden(m, d) {
  const b = [manifestNaam(d)];
  if (m.logo) b.push(m.logo);
  for (const a of m.presentatie?.afbeeldingen ?? []) b.push(a.bestand);
  if (m.presentatie?.documentatie) b.push(m.presentatie.documentatie);
  if (m.soort === "accessoire") b.push(m.profiel, m.handtekening);
  return b;
}

function appRegel(m, d, root, bronUrl) {
  const rel = (f) => posix(relative(root, join(d, f)));
  const b = m.beschrijving ?? {}, pr = m.presentatie ?? {};
  const e = { id: m.id, naam: m.naam, versie: String(m.versie), soort: m.soort ?? "server", kort: typeof b === "object" ? b.kort ?? "" : String(b) };
  if (typeof b === "object" && b.lang) e.lang = String(b.lang).trim();
  if (m.categorie) e.categorie = m.categorie;
  if (m.auteur?.naam) e.auteur = m.auteur.naam;
  if (m.logo) e.logo = rel(m.logo);
  if (pr.afbeeldingen?.length) e.afbeeldingen = pr.afbeeldingen.map((a) => ({ bestand: rel(a.bestand), uitleg: a.uitleg }));
  if (pr.documentatie) e.documentatie = rel(pr.documentatie);
  if (pr.website) e.website = pr.website;
  if (m.voorbeelden) e.voorbeelden = m.voorbeelden;
  if (bronUrl) e.bron = bronUrl;
  if (e.soort === "accessoire") { e.profiel = rel(m.profiel); e.handtekening = rel(m.handtekening); }
  return e;
}

/**
 * Maakt winkel.json in `root` uit winkel.yaml: de apps in de winkel zelf (app.yaml in de map, of apps/<id>/ en het oude
 * plugins/<id>/) en die uit `bronnen` (andere repo's op een vaste tag of commit). Van een bron komen alleen de bestanden
 * die de winkel nodig heeft in apps/<id>/ te staan (of in plugins/<id>/ als de winkel die map al heeft en apps/ niet),
 * naast winkel.json: de paden in winkel.json zijn relatief, zo werkt de winkel op elke Bolle. De sleutel "plugins" in
 * winkel.json blijft zo heten: zo leest BolleOS hem.
 */
export function bouwWinkel(root, { dev = false, log = () => {} } = {}) {
  const wy = join(root, "winkel.yaml");
  const meta = existsSync(wy) ? leesYaml(wy) : {};
  const w = { winkel: 1, naam: meta.naam ?? basename(root) };
  for (const k of ["beschrijving", "website"]) if (meta[k]) w[k] = String(meta[k]).trim();
  let pem = null;
  if (meta.sleutel) {
    if (!existsSync(join(root, meta.sleutel))) throw new Error(`winkel.yaml: sleutel ${meta.sleutel} ontbreekt (maak hem met: ${AANROEP} sleutel ${meta.sleutel})`);
    pem = readFileSync(join(root, meta.sleutel), "utf8"); w.sleutel = pem;
  }
  w.plugins = [];
  const bronnen = Array.isArray(meta.bronnen) ? meta.bronnen : [];
  const tmp = mkdtempSync(join(tmpdir(), "openbolle-winkel-"));
  const vanBron = new Map();                     // id -> bron-url (met commit)
  // waar de apps uit bronnen komen: apps/, behalve in een winkel die al plugins/ heeft en nog geen apps/ (die blijft gelijk)
  const uitMap = existsSync(join(root, "plugins")) && !existsSync(join(root, "apps")) ? "plugins" : "apps";
  try {
    for (const b of bronnen) {
      const { wortel, map, commit } = haalBron(b, tmp, dev);
      const mappen = heeftManifest(map) ? [map] : appMappen(map).filter((d) => heeftManifest(d));
      if (!mappen.length) throw new Error(`${b.repo ?? b.pad}: geen ${MANIFEST} gevonden${b.map ? ` in ${b.map}` : ""}`);
      for (const d of mappen) {
        const m = leesManifest(d);
        if (vanBron.has(m.id)) throw new Error(`app '${m.id}' komt uit twee bronnen`);
        const doel = join(root, uitMap, m.id);
        rmSync(doel, { recursive: true, force: true });
        for (const f of winkelBestanden(m, d)) {
          if (!existsSync(join(d, f))) throw new Error(`${m.id}: ${f} ontbreekt in de bron${m.soort === "accessoire" ? " (is het profiel daar ondertekend en vastgelegd?)" : ""}`);
          mkdirSync(dirname(join(doel, f)), { recursive: true });
          cpSync(join(d, f), join(doel, f));
        }
        const pad = posix(relative(wortel, d));
        vanBron.set(m.id, b.repo ? `${b.repo.replace(/(\.git)?\/?$/, "")}/tree/${commit}${pad ? "/" + pad : ""}` : null);
        log(`${m.id} ${m.versie} uit ${b.repo ?? b.pad}${commit ? ` (${b.tag ?? "commit"} ${commit.slice(0, 7)})` : ""}`);
      }
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }

  const mappen = [...(heeftManifest(root) ? [root] : []), ...appMappen(root).filter((d) => heeftManifest(d))];
  const gezien = new Set();
  for (const d of mappen) {
    const m = leesManifest(d);
    if (gezien.has(m.id)) throw new Error(`app '${m.id}' staat twee keer in de winkel`);
    gezien.add(m.id);
    const relMap = posix(relative(root, d));
    const bronUrl = vanBron.has(m.id) ? vanBron.get(m.id) : meta.bron ? String(meta.bron).replace(/\/$/, "") + (relMap ? "/" + relMap : "") : null;
    const e = appRegel(m, d, root, bronUrl);
    for (const f of [e.logo, e.documentatie, e.profiel, e.handtekening, ...(e.afbeeldingen ?? []).map((a) => a.bestand)]) {
      if (f && !existsSync(join(root, f))) throw new Error(`${m.id}: bestand ontbreekt: ${f}`);
    }
    if (e.soort === "accessoire") {
      if (!pem) throw new Error(`${m.id}: een winkel met accessoire-apps heeft een sleutel nodig (sleutel: in winkel.yaml)`);
      const data = readFileSync(join(root, e.profiel));
      if (!verify("sha256", data, pem, readFileSync(join(root, e.handtekening)))) {
        throw new Error(`${m.id}: de handtekening klopt niet met de sleutel van deze winkel (${vinger(pem)}). Elk profiel in een winkel is ondertekend met de sleutel van die winkel.`);
      }
      const q = JSON.parse(data.toString("utf8"));
      if (q.id !== e.id || String(q.versie) !== e.versie) throw new Error(`${m.id}: het ondertekende profiel is ${q.id} ${q.versie}, ${MANIFEST} zegt ${e.id} ${e.versie}`);
      const pf = profielFouten(q);
      if (pf.length) throw new Error(`${m.id}: ${pf[0]}`);
    }
    w.plugins.push(e);
  }
  const tekst = JSON.stringify(w, null, 1) + "\n";
  const acc = w.plugins.filter((p) => p.soort === "accessoire").length;
  if (acc && Buffer.byteLength(tekst) > MAX_INDEX) throw new Error(`winkel.json is te groot voor Bolle (${Buffer.byteLength(tekst)} bytes, hooguit ${MAX_INDEX}): kort de lange beschrijvingen in`);
  if (acc > MAX_IN_WINKEL) throw new Error(`te veel accessoire-apps (${acc}): Bolle toont er hooguit ${MAX_IN_WINKEL}`);
  return { tekst, winkel: w, vinger: pem ? vinger(pem) : null };
}

export async function winkel(args) {
  const dev = args.includes("--dev"), alleenKijken = args.includes("--controleer");
  const onbekend = args.filter((a) => a.startsWith("-") && !["--dev", "--controleer"].includes(a));
  if (onbekend.length) { console.error(`Onbekende optie: ${onbekend.join(" ")}`); return 2; }
  const root = resolve(zonderOpties(args)[0] ?? ".");
  if (!existsSync(join(root, "winkel.yaml")) && !heeftManifest(root) && !heeftAppMap(root)) {
    console.error(`Hier staat geen winkel.yaml en geen app. Zie ${AANROEP} --help`); return 2;
  }
  let r;
  try { r = bouwWinkel(root, { dev, log: (t) => console.log("  " + t) }); } catch (e) { console.error("FOUT  " + e.message); return 1; }
  const pad = join(root, "winkel.json");
  if (alleenKijken) {
    const gelijk = existsSync(pad) && readFileSync(pad, "utf8") === r.tekst;
    console.log(gelijk ? "goed  winkel.json is bijgewerkt" : "FOUT  winkel.json is niet bijgewerkt: draai `winkel` en leg het resultaat vast");
    return gelijk ? 0 : 1;
  }
  writeFileSync(pad, r.tekst);
  console.log(`${relative(process.cwd(), pad) || pad}: ${r.winkel.plugins.length} app(s)${r.vinger ? `, code van de winkel ${r.vinger}` : ""}`);
  return 0;
}

/* ---------- installeer (via USB op je eigen Bolle) ---------- */

export async function installeer(args) {
  const { openBolle, zoekPoort } = await import("./usb-node.mjs");
  const i = args.indexOf("--poort");
  const poort = i >= 0 ? args[i + 1] : zoekPoort();
  const map = zonderOpties(args)[0] ?? ".";
  let m;
  try { m = leesManifest(map); } catch (e) { console.error(e.message); return 1; }
  if (m.soort !== "accessoire") { console.error("Dit is geen accessoire-app. Een app met code probeer je met: dev --bolle"); return 1; }
  const zonder = args.includes("--zonder-handtekening");
  const f = accessoireFouten(map, m, { getekend: !zonder });
  if (f.length) { for (const x of f) console.error("  - " + x); return 1; }
  if (!poort) { console.error("Geen Bolle gevonden op USB. Sluit hem aan, of geef de poort op met --poort."); return 1; }
  const data = zonder ? compact(JSON.parse(readFileSync(join(map, "profiel.json"), "utf8"))) : readFileSync(join(map, m.profiel));
  const sig = zonder ? Buffer.alloc(0) : readFileSync(join(map, m.handtekening));
  let wacht = null;
  const b = openBolle(poort, { log: (soort, regel) => { if (soort === "bolle" && regel.startsWith("PROFIEL") && wacht) { const w = wacht; wacht = null; w(regel); } } });
  const zeg = (regel, ms = 8000) => new Promise((klaar) => {
    const t = setTimeout(() => { wacht = null; klaar("PROFIEL fout Bolle antwoordt niet"); }, ms);
    wacht = (r) => { clearTimeout(t); klaar(r); };
    b.usb.opdracht(regel);
  });
  try {
    let r = await zeg(`PROFIEL BEGIN ${data.length} ${sig.length}`);
    const alles = Buffer.concat([data, sig]);
    for (let k = 0; k < alles.length && r.startsWith("PROFIEL ok"); k += 72) r = await zeg("PROFIEL DEEL " + alles.subarray(k, k + 72).toString("base64"));
    if (r.startsWith("PROFIEL ok")) r = await zeg("PROFIEL EINDE", 12000);
    const goed = r.startsWith("PROFIEL bewaard") || r.startsWith("PROFIEL herstart");
    console.log(goed ? `${m.id} ${m.versie} staat op Bolle (${poort}).` : `Bolle weigert: ${r.replace(/^PROFIEL (fout )?/, "")}`);
    if (!goed && /handtekening|debugstand/.test(r)) {
      console.log(zonder ? "Zet eerst de debugstand aan: Menu → Systeem → Debug." : "Voeg eerst de winkel van deze app toe op Bolle (Instellen → Apps → Andere winkels), zodat hij de sleutel vertrouwt.");
    }
    return goed ? 0 : 1;
  } finally { b.stop(); }
}

/* ---------- nieuw --soort accessoire ---------- */

export function maakAccessoire(doel, id, naam, sjabloon) {
  cpSync(sjabloon, doel, { recursive: true });
  const u = randomUUID();                          // elke app zijn eigen Bluetooth-dienst
  const uuid = (n) => u.slice(0, 6) + n + u.slice(8);
  for (const f of [MANIFEST, "profiel.json", "winkel.yaml", "README.md", "docs/handleiding.md"]) {
    const p = join(doel, f);
    if (existsSync(p)) writeFileSync(p, readFileSync(p, "utf8").replaceAll("mijn-accessoire", id).replaceAll("Mijn accessoire", naam)
      .replaceAll("00000000-0000-4000-8000-000000000000", uuid("00")).replaceAll("00000001-0000-4000-8000-000000000000", uuid("01"))
      .replaceAll("00000002-0000-4000-8000-000000000000", uuid("02")));
  }
  writeFileSync(join(doel, ".gitignore"), "# je geheime sleutel hoort nooit in een repo\n*.pem\n!publiek.pem\n");
}

