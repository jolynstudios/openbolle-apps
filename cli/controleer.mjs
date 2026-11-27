// controleer: dezelfde regels als tools/controleer.py (schema, regels uit PLATFORM.md 7, contract), zonder Python.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { basename, join, relative, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { accessoireFouten } from "./accessoire.mjs";
import { MANIFEST, appMappen, blokProblemen, heeftManifest, leesManifest, leesNamen, leesSchema, postJson, startApp, vrijePoort, wachtOpGezond } from "./gedeeld.mjs";

const VERBODEN_WOORDEN = /(negeer|ignore|vergeet).{0,30}(instructie|instruction|regels|rules)|system prompt|systeemprompt/i;
const TYPEN = { string: "tekst", integer: "geheel getal", number: "getal", object: "object", array: "lijst", boolean: "true of false" };

let valideer;
function validator() {
  // Formaten (email, uri) worden net als in controleer.py niet gecontroleerd.
  valideer ??= new Ajv2020({ allErrors: true, strict: false, validateFormats: false, verbose: true }).compile(leesSchema());
  return valideer;
}

function inGewoneTaal(e) {
  const p = e.params ?? {};
  switch (e.keyword) {
    case "required": return `'${p.missingProperty}' ontbreekt`;
    case "additionalProperties": return `'${p.additionalProperty}' hoort hier niet`;
    case "type": return `moet een ${String(p.type).split(",").map((t) => TYPEN[t] ?? t).join(" of ")} zijn`;
    case "enum": return `moet een van deze zijn: ${p.allowedValues.join(", ")}`;
    case "const": return `moet ${JSON.stringify(p.allowedValue)} zijn`;
    case "pattern": return `past niet bij het patroon ${p.pattern}`;
    case "maxLength": return `te lang (hooguit ${p.limit} tekens)`;
    case "minLength": return `te kort (minstens ${p.limit} tekens)`;
    case "maxItems": return `te veel (hooguit ${p.limit})`;
    case "minItems": return `te weinig (minstens ${p.limit})`;
    case "maximum": return `moet hooguit ${p.limit} zijn`;
    case "minimum": return `moet minstens ${p.limit} zijn`;
    case "uniqueItems": return `staat dubbel (nummer ${p.j} en ${p.i})`;
    case "contains": return e.schema?.const !== undefined ? `moet '${e.schema.const}' bevatten` : "mist een verplichte waarde";
    case "not": return e.schema?.required ? `'${e.schema.required.join("', '")}' mag hier niet` : "is in deze vorm niet toegestaan";
    case "oneOf": return "past bij geen van de toegestane vormen";
    default: return e.message ?? e.keyword;
  }
}

function schemaFouten(pid, m) {
  const v = validator();
  if (v(m)) return [];
  let errs = v.errors.filter((e) => e.keyword !== "if");
  // net als jsonschema: bij oneOf alleen de oneOf-fout, niet alle fouten uit elke vorm
  const oneOfs = errs.filter((e) => e.keyword === "oneOf").map((e) => e.schemaPath.replace(/\/oneOf$/, "/oneOf/"));
  errs = errs.filter((e) => e.keyword === "oneOf" || !oneOfs.some((s) => e.schemaPath.startsWith(s)));
  const pad = (e) => e.instancePath.replace(/^\//, "").replace(/~1/g, "/").replace(/~0/g, "~");
  errs.sort((a, b) => pad(a).localeCompare(pad(b), "nl", { numeric: true }));
  const gezien = new Set();
  const uit = [];
  for (const e of errs) {
    const regel = `${pid}: ${pad(e) || "(manifest)"}: ${inGewoneTaal(e)}`;
    if (!gezien.has(regel)) { gezien.add(regel); uit.push(regel); }
  }
  return uit;
}

/** Fouten in het manifest van één map (leeg = goed). Dezelfde regels als fouten_voor() in tools/controleer.py. */
// PNG, vierkant, minstens 256 px, hooguit 100 KB (de maat staat in de IHDR-kop)
export function logoFouten(pad) {
  if (!existsSync(pad)) return ["bestand ontbreekt"];
  const b = readFileSync(pad);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (b.length < 24 || !b.subarray(0, 8).equals(sig) || b.toString("latin1", 12, 16) !== "IHDR") return ["geen PNG"];
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  const f = [];
  if (w !== h) f.push(`niet vierkant (${w} × ${h})`);
  if (Math.min(w, h) < 256) f.push(`te klein (${w} × ${h}, minstens 256 × 256)`);
  if (b.length > 100 * 1024) f.push(`te groot (${Math.floor(b.length / 1024)} KB, hooguit 100 KB)`);
  return f;
}

// scherm voor de winkel: PNG, hooguit 466 × 466, hooguit 200 KB
export function afbeeldingFouten(pad) {
  if (!existsSync(pad)) return ["bestand ontbreekt"];
  const b = readFileSync(pad);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (b.length < 24 || !b.subarray(0, 8).equals(sig) || b.toString("latin1", 12, 16) !== "IHDR") return ["geen PNG"];
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  const f = [];
  if (w > 466 || h > 466) f.push(`te groot (${w} × ${h}, hooguit 466 × 466)`);
  if (b.length > 200 * 1024) f.push(`te groot (${Math.floor(b.length / 1024)} KB, hooguit 200 KB)`);
  return f;
}

export function foutenVoor(map) {
  const pid = basename(resolve(map));
  if (!heeftManifest(map)) return [`${pid}: ${MANIFEST} ontbreekt`];
  let m;
  try { m = leesManifest(map); } catch (e) { return [`${pid}: ${e.message}`]; }
  if (m?.soort === "accessoire") return accessoireFouten(map, m);      // een profiel, geen code: eigen regels
  const f = schemaFouten(pid, m);
  if (f.length) return f;
  if (m.id !== pid) f.push(`${pid}: id '${m.id}' moet gelijk zijn aan de mapnaam`);
  if (!existsSync(join(map, "Dockerfile"))) f.push(`${pid}: Dockerfile ontbreekt`);
  if (m.logo) for (const x of logoFouten(join(map, m.logo))) f.push(`${pid}: logo ${m.logo}: ${x}`);
  for (const a of m.presentatie?.afbeeldingen ?? []) for (const x of afbeeldingFouten(join(map, a.bestand))) f.push(`${pid}: afbeelding ${a.bestand}: ${x}`);
  if (m.presentatie?.documentatie && !existsSync(join(map, m.presentatie.documentatie))) f.push(`${pid}: documentatie ${m.presentatie.documentatie} ontbreekt`);
  const r = new Set(m.rechten);
  const tools = m.tools ?? [];
  for (const t of tools) {
    if (`${pid}__${t.naam}`.length > 64) f.push(`${pid}: toolnaam ${t.naam} te lang (met app-id max 64)`);
    if (VERBODEN_WOORDEN.test(t.beschrijving)) f.push(`${pid}: beschrijving van ${t.naam} lijkt instructies aan het taalmodel te bevatten`);
  }
  if (tools.length && !r.has("spraak:tools")) f.push(`${pid}: tools zonder recht spraak:tools`);
  if (m.blokken?.length && !r.has("blokken:tonen")) f.push(`${pid}: blokken zonder recht blokken:tonen`);
  if (m.taken?.length && !r.has("achtergrond:taken")) f.push(`${pid}: taken zonder recht achtergrond:taken`);
  const hosts = m.netwerk?.uitgaand ?? [];
  if (hosts.length && !r.has("netwerk:uitgaand")) f.push(`${pid}: netwerk.uitgaand zonder recht netwerk:uitgaand`);
  if (r.has("netwerk:uitgaand") && !hosts.length) f.push(`${pid}: recht netwerk:uitgaand zonder hosts`);
  for (const h of hosts) {
    const i = h.lastIndexOf(":");
    const naam = i >= 0 ? h.slice(0, i) : "";
    const poort = i >= 0 ? h.slice(i + 1) : h;
    if (poort !== "443") f.push(`${pid}: ${h}: alleen poort 443`);
    if (isIP(naam.replace(/^\[|\]$/g, ""))) f.push(`${pid}: ${h}: geen IP-adressen, alleen namen`);
    if (naam.slice(1).includes("*") || (naam.startsWith("*") && !naam.startsWith("*."))) f.push(`${pid}: ${h}: * alleen als eerste label`);
    if (/(^|\.)(openbolle\.nl|redlinewars\.online|localhost|internal|local)$/.test(naam)) f.push(`${pid}: ${h}: verboden host`);
  }
  for (const t of tools) {
    if (/slot|alarm|garage|betaal|deur_open/.test(t.naam) && !t.bevestigen) {
      f.push(`${pid}: ${t.naam} lijkt een handeling met gevolgen: zet bevestigen: true`);
    }
  }
  return f;
}

// ---------------------------------------------------------------- let op (waarschuwingen, geen fouten)

/** De broncode van een app (zonder node_modules, dist en de kopie van de SDK), hooguit 200 bestanden. */
function bronBestanden(map) {
  const uit = [];
  const loop = (d) => {
    let namen;
    try { namen = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of namen) {
      if (uit.length >= 200) return;
      const p = join(d, e.name);
      if (e.isDirectory()) { if (!["node_modules", "dist", ".git", "__pycache__"].includes(e.name)) loop(p); }
      else if (/\.(py|ts|js|mjs)$/.test(e.name) && e.name !== "openbolle.ts" && !/\.d\.ts$/.test(e.name)) uit.push(p);
    }
  };
  loop(map);
  return uit;
}

/**
 * Wat beter kan maar de controle niet laat falen. Zonder de app te starten: namen in een melding in de code (icoon,
 * kleur, geluid) die BolleOS niet kent, en een melding in de code zonder het recht meldingen:sturen.
 * Met --contract kijkt vergelijk() ook naar het echte blok (lengtes, regels, melding).
 */
export function waarschuwingenVoor(map) {
  const pid = basename(resolve(map));
  let m;
  try { m = leesManifest(map); } catch { return []; }
  if (!m || m.soort === "accessoire") return [];
  const namen = leesNamen();
  const r = new Set(m.rechten ?? []);
  const w = [];
  let melding = null;
  const lijst = { icoon: namen.iconen, kleur: namen.kleuren, geluid: namen.geluiden };
  for (const f of bronBestanden(map)) {
    const regels = readFileSync(f, "utf8").split("\n");
    regels.forEach((regel, i) => {
      const t = regel.trim();
      if (/^(#|\/\/|\*|\/\*)/.test(t)) return;                      /* commentaar */
      for (const [, veld, naam] of t.matchAll(/["']?\b(icoon|kleur|geluid)\b["']?\s*:\s*["']([^"'\n]*)["']/g)) {
        const plek = `${relative(map, f)}:${i + 1}`;
        melding ??= plek;
        if (veld === "kleur" && /^#[0-9A-Fa-f]{6}$/.test(naam)) continue;
        if (!lijst[veld].includes(naam)) w.push(`${pid}: ${plek}: ${veld} '${naam}' kent BolleOS niet (zie schema/bolleos.json); de broker laat die melding vallen`);
      }
    });
  }
  if (melding && !r.has("meldingen:sturen")) w.push(`${pid}: ${melding}: de code lijkt een melding te sturen, maar het recht meldingen:sturen ontbreekt; de broker laat hem vallen`);
  for (const b of m.blokken ?? []) {
    if (b.soort === "melding" && !r.has("meldingen:sturen")) w.push(`${pid}: blok ${b.id} is een melding, maar het recht meldingen:sturen ontbreekt`);
  }
  return w;
}

// ---------------------------------------------------------------- contract

/**
 * Vergelijkt tools/list en de blokken met het manifest, met een app die al draait op `poort`. Wat aan de inhoud van
 * een blok beter kan (lengtes, regels, melding) komt in `letOp`; dat laat de controle niet falen.
 */
async function vergelijk(pid, m, poort, letOp = []) {
  const rechten = new Set(m.rechten ?? []);
  const { json } = await postJson(`http://127.0.0.1:${poort}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/list" }, 5000);
  const namen = (json?.result?.tools ?? []).map((t) => t.name).sort();
  const verwacht = (m.tools ?? []).map((t) => t.naam).sort();
  const f = JSON.stringify(namen) === JSON.stringify(verwacht) ? []
    : [`${pid}: tools/list [${namen.join(", ")}] is niet gelijk aan het manifest [${verwacht.join(", ")}]`];
  for (const b of m.blokken ?? []) { // elk blok moet antwoorden met titel/waarde/regels (ook zonder plek)
    try {
      const { json: j } = await postJson(`http://127.0.0.1:${poort}/blok/${b.id}`,
        { context: { installatie: "ins_test", instellingen: {}, aanroep_token: "x" } }, 5000);
      if (!j || typeof j !== "object" || Array.isArray(j) || (j.regels !== undefined && !Array.isArray(j.regels))) {
        f.push(`${pid}: blok ${b.id} geeft geen geldig blok`);
      } else for (const x of blokProblemen(j, rechten)) letOp.push(`${pid}: blok ${b.id}: ${x}`);
    } catch (e) { f.push(`${pid}: blok ${b.id}: ${e.message}`); }
  }
  return f;
}

function docker(args, { timeoutMs = 600_000, stil = true } = {}) {
  return new Promise((klaar) => {
    let uit = "", fout = "";
    let p;
    try { p = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] }); } catch { return klaar({ code: -1, uit, fout: "docker niet gevonden" }); }
    const t = setTimeout(() => { p.kill("SIGKILL"); fout += "duurde te lang"; }, timeoutMs);
    p.stdout.on("data", (d) => { uit += d; });
    p.stderr.on("data", (d) => { fout += d; if (!stil) process.stderr.write(d); });
    p.on("error", () => { clearTimeout(t); klaar({ code: -1, uit, fout: "docker niet gevonden" }); });
    p.on("exit", (code) => { clearTimeout(t); klaar({ code: code ?? -1, uit: uit.trim(), fout: fout.trim() }); });
  });
}

let dockerKan;
async function dockerBereikbaar() {
  dockerKan ??= docker(["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 8000 }).then((r) => r.code === 0);
  return dockerKan;
}

async function contractDocker(map, pid, m, letOp) {
  const img = `openbolle-test/${pid}`;
  const bouw = await docker(["build", "-q", "-t", img, map]);
  if (bouw.code !== 0) return [`${pid}: docker build mislukte: ${bouw.fout.split("\n").slice(-3).join(" ")}`];
  const run = await docker(["run", "-d", "--rm", "-p", "127.0.0.1::8080", "--read-only", "--tmpfs", "/tmp",
    "--cap-drop", "ALL", "--user", "65532:65532", img], { timeoutMs: 60_000 });
  if (run.code !== 0) return [`${pid}: docker run mislukte: ${run.fout}`];
  const cid = run.uit;
  try {
    const poort = (await docker(["port", cid, "8080"], { timeoutMs: 15_000 })).uit.split("\n")[0].split(":").pop();
    if (!(await wachtOpGezond(poort, 15_000))) return [`${pid}: /gezond antwoordt niet`];
    return await vergelijk(pid, m, poort, letOp);
  } catch (e) {
    return [`${pid}: ${e.message}`];
  } finally {
    await docker(["rm", "-f", cid], { timeoutMs: 30_000 });
  }
}

async function contractLokaal(map, pid, m, letOp) {
  const poort = await vrijePoort();
  let kind;
  try {
    kind = await startApp(map, m, { poort, uitvoer: "stil", log: () => {} });
    const leeft = () => kind.exitCode === null && kind.signalCode === null;
    if (!(await wachtOpGezond(poort, 120_000, leeft))) return [`${pid}: /gezond antwoordt niet${leeft() ? "" : " (de app stopte meteen)"}`];
    return await vergelijk(pid, m, poort, letOp);
  } catch (e) {
    return [`${pid}: ${e.message}`];
  } finally {
    await kind?.stop();
  }
}

// ---------------------------------------------------------------- opdracht

function standaardMappen() {
  if (heeftManifest(".")) return ["."];
  const mappen = appMappen(".");
  return mappen.length ? mappen : null;
}

export async function controleer(args) {
  const doeContract = args.includes("--contract");
  const lokaal = args.includes("--lokaal");
  const onbekend = args.filter((a) => a.startsWith("-") && !["--contract", "--lokaal"].includes(a));
  if (onbekend.length) { console.error(`Onbekende optie: ${onbekend.join(" ")}`); return 2; }
  const mappen = args.filter((a) => !a.startsWith("-"));
  const lijst = mappen.length ? mappen : standaardMappen();
  if (!lijst?.length) {
    console.error(`Geen app gevonden: hier staat geen ${MANIFEST} en geen map apps/. Geef een map op, bijvoorbeeld: controleer mijn-app`);
    return 2;
  }
  let metDocker = false;
  if (doeContract && !lokaal) {
    metDocker = await dockerBereikbaar();
    if (!metDocker) console.log("Docker is niet bereikbaar: voor het contract start ik de app lokaal (zonder container). De controle bij een pull request gebruikt wel Docker.");
  }
  const alle = [], letOp = [];
  for (const d of lijst) {
    const pid = basename(resolve(d));
    let f = foutenVoor(d);
    const m0 = f.length ? null : leesManifest(d);
    if (!f.length) letOp.push(...waarschuwingenVoor(d));
    if (!f.length && doeContract && m0.soort !== "accessoire") {
      const m = m0;
      f = metDocker ? await contractDocker(d, pid, m, letOp) : await contractLokaal(d, pid, m, letOp);
    }
    console.log((f.length ? "FOUT  " : "goed  ") + pid);
    alle.push(...f);
  }
  for (const x of alle) console.log("  - " + x);
  if (letOp.length) {
    console.log(`Let op (geen fout: de controle slaagt wel)${doeContract ? "" : ". Met --contract kijk ik ook naar wat je blokken echt teruggeven"}:`);
    for (const x of letOp) console.log("  - " + x);
  }
  return alle.length ? 1 : 0;
}
