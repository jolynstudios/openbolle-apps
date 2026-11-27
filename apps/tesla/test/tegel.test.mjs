// Tests zonder netwerk: het scherm en de meldingen van de Tesla-app uit een stand.
// Draaien: npm test   (bouwt eerst met tsc, test dan dist/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { klaarSinds, laadTekst, melding, tegel, zin } from "../dist/tegel.js";

const NU = Date.parse("2026-11-24T15:00:00Z");          // 16:00 in Nederland
const MIN = 60_000;
const wakker = {
  tijd: NU - 5 * MIN, gekeken: NU - 5 * MIN, naam: "Rood", slaapt: false, accu: 52, bereikKm: 266,
  laden: "Disconnected", opSlot: true, aanwezig: false, binnen: 19.6, buiten: 7.8, km: 43740,
};

test("de accu groot met de ring, het bereik als eerste regel", () => {
  const b = tegel(wakker, NU);
  assert.equal(b.titel, "Tesla");
  assert.equal(b.waarde, "52%");
  assert.equal(b.meter, 52);
  assert.deepEqual(b.regels, ["266 km bereik", "Op slot", "Binnen 20 °C, buiten 8 °C", "Kilometerstand 43.740 km", "Stand van 15:55"]);
  assert.equal(b.melding, undefined);
});

test("waarde kort genoeg voor het grote getal en het beginscherm", () => {
  assert.ok(tegel({ ...wakker, accu: 100 }, NU).waarde.length <= 10);
});

test("laden: kort in beeld, uitgebreid voor de assistent", () => {
  const s = { ...wakker, laden: "Charging", vermogenKw: 11, volOverMin: 95, limiet: 80 };
  assert.deepEqual(tegel(s, NU).regels.slice(0, 3), ["266 km bereik", "Laadt 11 kW, vol om 17:30", "Op slot"]);
  assert.equal(laadTekst(s), "laadt met 11 kW, vol over 1 uur 35 min, tot 80%");
  assert.match(zin(s), /^accu 52% \(ongeveer 266 km\), laadt met 11 kW/);
});

test("slaapt: de laatst bekende stand, en dat hij slaapt staat in beeld", () => {
  const b = tegel({ ...wakker, slaapt: true, tijd: NU - 26 * 60 * MIN }, NU);
  assert.equal(b.waarde, "52%");
  assert.equal(b.regels[2], "Slaapt, stand van 23 nov 14:00");
  assert.ok(b.regels.length <= 6);
});

test("nog geen stand: geen waarde, een kaart en de knoppen", () => {
  const b = tegel({ tijd: 0, naam: "je Tesla", slaapt: true }, NU);
  assert.equal(b.waarde, "");
  assert.equal(b.meter, undefined);
  assert.deepEqual(b.regels, ["De auto slaapt", "Nog geen stand bekend", "Vraag Bolle om hem te wekken"]);
  assert.deepEqual(b.schermen.map((s) => s.soort), ["kaarten", "knoppen"]);
  assert.equal(b.schermen[0].kaarten[0].titel, "De auto slaapt");
});

test("twee schermen in de kleur van Tesla: de accu en de knoppen die de app echt kan", () => {
  const b = tegel(wakker, NU);
  assert.equal(b.kleur, "#E31937");
  assert.equal(b.blok, "accu");
  const [accu, kn] = b.schermen;
  assert.deepEqual([accu.soort, accu.waarde, accu.meter, accu.regel], ["waarde", "52%", 52, "266 km bereik"]);
  assert.deepEqual(kn.knoppen.map((k) => k.actie), ["ververs", "wekken"]);
  for (const k of kn.knoppen) assert.ok(k.tekst.length <= 10 && /^[a-z0-9-]{1,32}$/.test(k.actie));
  assert.ok(accu.regel.length <= 24);
  assert.equal(tegel({ ...wakker, slaapt: true }, NU).schermen[0].regel, "Slaapt · 266 km");
});

test("melding: niet op slot terwijl er niemand bij is", () => {
  const s = { ...wakker, opSlot: false, aanwezig: false };
  assert.deepEqual(tegel(s, NU).melding, { vorm: "alarm", id: "niet-op-slot", titel: "Tesla niet op slot", icoon: "car", kleur: "gevaar", geluid: "SFX_MSG" });
  assert.equal(melding({ ...s, aanwezig: true }, NU), undefined);           // iemand zit erin of staat erbij
  assert.equal(melding({ ...s, aanwezig: undefined }, NU), undefined);      // oude stand zonder dat veld
  assert.equal(melding({ ...s, tijd: NU - 7 * 60 * MIN }, NU), undefined);  // te oud om nog iets te zeggen
});

test("melding: klaar met laden, alleen na laden, met een vaste id", () => {
  const laadt = { ...wakker, laden: "Charging" };
  const klaar = { ...wakker, laden: "Complete", limiet: 80 };
  const t = klaarSinds(laadt, klaar, NU);
  assert.equal(t, NU);
  assert.equal(klaarSinds({ ...klaar, klaarSinds: t }, klaar, NU + 20 * MIN), t);   // blijft hetzelfde
  assert.equal(klaarSinds({ ...wakker }, klaar, NU), undefined);                     // niet zien laden: geen melding
  const m = melding({ ...klaar, klaarSinds: t }, NU + 20 * MIN);
  assert.equal(m.titel, "Tesla klaar met laden");
  assert.equal(m.id, `laden-klaar-${t / 1000}`);
  assert.equal(melding({ ...klaar, klaarSinds: t }, NU + 3 * 60 * MIN), undefined);   // na een paar uur niet meer
  assert.equal(tegel({ ...klaar, klaarSinds: t }, NU).regels[1], "Klaar met laden (80%)");
});

test("meldingen gebruiken alleen namen van BolleOS en een korte titel", async () => {
  const { readFileSync } = await import("node:fs");
  const namen = JSON.parse(readFileSync(new URL("../../../schema/bolleos.json", import.meta.url), "utf8"));
  for (const m of [melding({ ...wakker, opSlot: false }, NU), melding({ ...wakker, laden: "Complete", klaarSinds: NU }, NU)]) {
    assert.ok(namen.iconen.includes(m.icoon) && ["info", "ok", "gevaar", "ernstig", "agenda", "telefoon"].includes(m.kleur) && namen.geluiden.includes(m.geluid));
    assert.ok(Buffer.byteLength(m.titel) <= 27);
  }
});
