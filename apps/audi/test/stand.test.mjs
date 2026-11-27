// Tests zonder netwerk: opgenomen vormen van de antwoorden van myAudi door de lezer en de zinnen.
// Draaien: npm test   (bouwt eerst met tsc, test dan dist/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AlleenFouten, klaarSinds, laadTekst, leesAutos, leesPlek, leesStand, meter, tegelMelding, tegelRegels, tegelWaarde, zin } from "../dist/stand.js";
import { foutcode, leesFormulier } from "../dist/audi.js";

const vb = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8"));
const NU = Date.parse("2026-11-23T10:00:00Z");

test("elektrisch: accu, bereik, laden, slot", () => {
  const s = leesStand(vb("etron"), NU);
  assert.equal(s.soort, "electric");
  assert.equal(s.accu, 69);
  assert.equal(s.bereikKm, 300);
  assert.equal(s.km, 43740);
  assert.equal(s.opSlot, true);
  assert.deepEqual(s.ramenOpen, []);
  assert.equal(s.tijd, Date.parse("2026-11-23T08:09:17Z"));
  assert.equal(laadTekst(s), "laadt met 11 kW, vol over 1 uur 35 min, tot 80%");
  assert.equal(tegelWaarde(s), "69%");
  assert.equal(meter(s), 69);
  assert.match(zin(s), /^accu 69% \(ongeveer 300 km\), op slot, deuren en ramen dicht, laadt met 11 kW/);
  assert.match(zin(s), /kilometerstand 43\.740 km$/);
  const r = tegelRegels(s, Date.parse("2026-11-23T09:15:00Z"));
  assert.deepEqual(r, ["300 km bereik", "Op slot, alles dicht", "Laadt 11 kW, vol om 10:44", "Kilometerstand 43.740 km", "Stand van 09:09"]);
  assert.equal(tegelRegels(s, NU)[2], "Laadt 11 kW");   // "vol om" (10:44) al voorbij: de stand is oud
});

test("benzine: tank, niet op slot, raam open, geen laadtekst", () => {
  const s = leesStand(vb("benzine"), NU);
  assert.equal(s.brandstof, 63);
  assert.equal(s.accu, undefined);
  assert.equal(s.opSlot, false);
  assert.deepEqual(s.ramenOpen, ["linksvoor"]);
  assert.equal(tegelWaarde(s), "63%");
  assert.deepEqual(tegelRegels(s, NU).slice(0, 3), ["412 km bereik", "Niet op slot", "Open: raam linksvoor"]);
  assert.equal(zin(s), "tank 63% (ongeveer 412 km), niet op slot, open: raam linksvoor, kilometerstand 128.455 km");
});

test("plug-in hybride: tank en accu, niet aan de lader", () => {
  const s = leesStand(vb("phev"), NU);
  assert.equal(s.soort, "hybrid");
  assert.equal(s.brandstof, 55);
  assert.equal(s.accu, 92);
  assert.equal(meter(s), 55);
  assert.equal(laadTekst(s), "niet aan de lader");
  assert.match(zin(s), /^tank 55% \(520 km\), accu 92% \(48 km elektrisch\), samen ongeveer 568 km, op slot/);
  assert.equal(tegelWaarde(s), "55%");             // de tank, net als de ring
  assert.deepEqual(tegelRegels(s, NU).slice(0, 3), ["568 km bereik", "Accu 92% (48 km elektrisch)", "Op slot, alles dicht"]);
});

test("alleen fouten van CARIAD: AlleenFouten (de vorige stand blijft staan)", () => {
  assert.throws(() => leesStand(vb("fouten"), NU), AlleenFouten);
});

test("parkeerplek en auto's", () => {
  assert.deepEqual(leesPlek(vb("parkeerplek")), { lat: 52.090736, lon: 5.12142, tijd: Date.parse("2026-11-23T08:09:17Z") });
  assert.equal(leesPlek({}), null);
  assert.deepEqual(leesAutos(vb("autos")), [{ vin: "WAUZZZGE0PB000001", naam: "Q8 e-tron" }]);
});

test("inlogpagina van Auth0: formulier en foutcode", () => {
  const html = `<form class="x" data-form-primary="true" method="POST"><input type="hidden" name="state" value="abc&amp;d"/>
    <input id="username" name="username" value=""/><input id="password" type="password" name="password"/></form>`;
  assert.deepEqual(leesFormulier(html), { velden: { state: "abc&d" }, wachtwoord: true, actie: undefined });
  assert.equal(foutcode('<span id="error-element-username" data-error-code="wrong-email-credentials">'), "wrong-email-credentials");
});

test("waarde: kort, en het bereik als er geen percentage is; niets bekend = leeg", () => {
  const s = leesStand(vb("etron"), NU);
  for (const n of ["etron", "benzine", "phev"]) assert.ok(tegelWaarde(leesStand(vb(n), NU)).length <= 10);
  const zonder = { ...s, accu: undefined, motoren: [] };
  assert.equal(tegelWaarde(zonder), "300 km");
  assert.equal(meter(zonder), undefined);
  assert.equal(tegelRegels(zonder, NU)[0], "Op slot, alles dicht");   // het bereik staat dan al groot
  assert.equal(tegelWaarde({ ...zonder, bereikKm: undefined }), "");
});

test("melding uit zichzelf: klaar met laden, alleen als we hem zagen laden", () => {
  const laadt = leesStand(vb("etron"), NU);
  const klaar = { ...laadt, laden: { ...laadt.laden, staat: "chargePurposeReachedAndConservation" } };
  const t = klaarSinds(laadt, klaar, NU);
  assert.equal(t, NU);
  assert.equal(klaarSinds({ ...klaar, klaarSinds: t }, klaar, NU + 900_000), t);   // dezelfde id zolang hij klaar is
  assert.equal(klaarSinds(null, klaar, NU), undefined);                           // niet zien laden: geen melding
  assert.deepEqual(tegelMelding({ ...klaar, klaarSinds: t }, NU + 900_000),
    { id: `laden-klaar-${t / 1000}`, titel: "Audi klaar met laden", icoon: "bolt", kleur: "ok", geluid: "SFX_MSG" });
  assert.equal(tegelMelding({ ...klaar, klaarSinds: t }, NU + 3 * 3600_000), undefined);   // na een paar uur niet meer
  assert.equal(tegelMelding(laadt, NU), undefined);
  assert.equal(tegelRegels(klaar, NU)[2], "Klaar met laden (80%)");
});
