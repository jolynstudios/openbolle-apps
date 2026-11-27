// Nagebootste myAudi om de app van begin tot eind te testen zonder account (alleen lokaal, http).
//   node test/nep-audi.mjs [poort] [etron|benzine|phev|fouten]
// Start de app dan met AUDI_IDENTITY=http://127.0.0.1:<poort> AUDI_BFF=http://127.0.0.1:<poort>
// AUDI_GRAPHQL=http://127.0.0.1:<poort>/vgql/v1/graphql. Goed account: test@example.com / goed-wachtwoord.
// Speelt na wat de echte inlogserver (Auth0, group.identity.vwgroup.io) deed bij een proef op 24-11-2026:
// 302 naar /u/login?state=..., een formulier met state/username/password, 400 met data-error-code bij een fout.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const poort = Number(process.argv[2] ?? 4791);
const soort = process.argv[3] ?? "etron";
const vb = (n) => readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8");
const TERUG = "http://localhost:8080/myaudi-callback";
const sessies = new Map();          // auth0-state -> {state, challenge, ingelogd}
const codes = new Map();            // code -> challenge
const toegang = new Set();
const verversers = new Set();
const tel = {};
let rest = Number(process.env.NEP_REST ?? 500);

function body(req) {
  return new Promise((ok) => { const d = []; req.on("data", (x) => d.push(x)); req.on("end", () => ok(Buffer.concat(d).toString())); });
}
const formulier = (s, fout = "") => `<!DOCTYPE html><html><head><title>Log in | myAudi App</title></head><body>
<form class="c1" data-form-primary="true" method="POST"><input type="hidden" name="state" value="${s}"/>
<input class="input" inputMode="email" id="username" type="text" name="username" value=""/>${fout}
<input class="input" id="password" type="password" name="password"/><button type="submit" name="action" value="default">Next</button></form></body></html>`;

createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${poort}`);
  tel[u.pathname.replace(/WAU\w+/, "<vin>")] = (tel[u.pathname.replace(/WAU\w+/, "<vin>")] ?? 0) + 1;
  const stuur = (code, b, kop = {}) => { res.writeHead(code, kop); res.end(b); };
  const koekje = (req.headers.cookie ?? "").includes("auth0=");
  if (u.pathname === "/authorize" && req.method === "GET") {
    const q = u.searchParams;
    if (q.get("client_id") !== "09b6cbec-cd19-4589-82fd-363dfa8c24da@apps_vw-dilab_com" || q.get("redirect_uri") !== TERUG || q.get("code_challenge_method") !== "S256") return stuur(400, "bad authorize");
    const s = randomBytes(12).toString("base64url");
    sessies.set(s, { state: q.get("state"), challenge: q.get("code_challenge") });
    return stuur(302, "Found", { Location: `/u/login?state=${s}&ui_locales=nl-NL`, "Set-Cookie": `auth0=${s}; Path=/; HttpOnly` });
  }
  if (u.pathname === "/u/login" && req.method === "GET") return stuur(200, formulier(u.searchParams.get("state")), { "Content-Type": "text/html" });
  if (u.pathname === "/u/login" && req.method === "POST") {
    const f = new URLSearchParams(await body(req));
    const s = sessies.get(f.get("state"));
    if (!s || !koekje || f.get("action") !== "default") return stuur(400, "bad state");
    if (f.get("username") !== "test@example.com" || f.get("password") !== "goed-wachtwoord") {
      return stuur(400, formulier(f.get("state"), '<span id="error-element-username" data-error-code="wrong-email-credentials"></span>'), { "Content-Type": "text/html" });
    }
    s.ingelogd = true;
    return stuur(302, "Found", { Location: `/authorize/resume?state=${f.get("state")}` });
  }
  if (u.pathname === "/authorize/resume") {
    const s = sessies.get(u.searchParams.get("state"));
    if (!s?.ingelogd || !koekje) return stuur(400, "bad resume");
    const code = randomBytes(12).toString("base64url");
    codes.set(code, s.challenge);
    return stuur(302, "Found", { Location: `${TERUG}?code=${code}&state=${encodeURIComponent(s.state)}` });
  }
  if (u.pathname === "/oauth/token" && req.method === "POST") {
    const f = new URLSearchParams(await body(req));
    const nieuw = () => {
      const t = "at_" + randomBytes(24).toString("base64url"), r = "rt_" + randomBytes(24).toString("base64url");
      toegang.add(t); verversers.add(r);
      return JSON.stringify({ access_token: t, refresh_token: r, id_token: "x.y.z", token_type: "Bearer", expires_in: Number(process.env.NEP_GELDIG ?? 3600) });
    };
    if (f.get("grant_type") === "authorization_code") {
      const ch = codes.get(f.get("code"));
      codes.delete(f.get("code"));
      const ok = ch && createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") === ch && f.get("redirect_uri") === TERUG;
      return ok ? stuur(200, nieuw(), { "Content-Type": "application/json" }) : stuur(403, JSON.stringify({ error: "invalid_grant" }));
    }
    if (f.get("grant_type") === "refresh_token") {
      if (!verversers.delete(f.get("refresh_token")) || f.get("audience") !== "https://api.cariad.com") return stuur(403, JSON.stringify({ error: "invalid_grant" }));
      return stuur(200, nieuw(), { "Content-Type": "application/json" });
    }
    return stuur(400, JSON.stringify({ error: "unsupported_grant_type" }));
  }
  if (u.pathname === "/tel") return stuur(200, JSON.stringify(tel));
  const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (!toegang.has(auth)) return stuur(401, "{}");
  const kop = { "Content-Type": "application/json", "Vcf-Remaining-Calls": String(--rest) };
  if (u.pathname === "/vgql/v1/graphql" && req.method === "POST") return stuur(200, vb("autos"), kop);
  if (/^\/vehicle\/v1\/vehicles\/WAU\w+\/selectivestatus$/.test(u.pathname)) return stuur(200, vb(soort), kop);
  if (/^\/vehicle\/v1\/vehicles\/WAU\w+\/parkingposition$/.test(u.pathname)) return process.env.NEP_RIJDT ? stuur(204, "", kop) : stuur(200, vb("parkeerplek"), kop);
  stuur(404, "{}");
}).listen(poort, "127.0.0.1", () => console.log(`nep-myAudi op http://127.0.0.1:${poort} (${soort})`));
