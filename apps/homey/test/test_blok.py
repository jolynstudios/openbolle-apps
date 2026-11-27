"""Tests zonder netwerk: het scherm van de Homey-app op Bolle. Draaien: python3 -m unittest discover -s test"""
import json, os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import plugin

NAMEN = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "..", "schema", "bolleos.json")))

def dev(id, naam, klasse, **caps):
    return {"id": id, "name": naam, "class": klasse, "_kamer": "", "capabilitiesObj": {k: {"value": v} for k, v in caps.items()}}

HUIS = [dev("t", "Thermostaat", "thermostat", measure_temperature=20.5, target_temperature=21.0),
        dev("l1", "Plafond", "light", onoff=True), dev("l2", "Spots", "light", onoff=True), dev("l3", "Hal", "light", onoff=False),
        dev("s", "Voordeur", "lock", locked=True)]

class Blok(unittest.TestCase):
    def setUp(self):
        self.oud = plugin.lees, plugin.homey
        plugin.sessies["ins"] = ("https://x", "s", "Homey van de familie Jansen")
        self.me, self.flows, self.moods, self.aanroepen = {}, {}, {}, []
        def homey(ctx, pad, methode="GET", body=None):
            self.aanroepen.append((pad, methode, body))
            if pad == "/users/user/me": return {"properties": self.me}
            if pad == "/flow/flow": return self.flows
            if pad == "/flow/advancedflow": return {}
            if pad == "/moods/mood": return self.moods
            return {}
        plugin.homey = homey
    def tearDown(self):
        plugin.lees, plugin.homey = self.oud
        plugin.sessies.clear(); plugin._gebruiker_cache.clear(); plugin._flow_cache.clear(); plugin._mood_cache.clear()
    def blok(self, devs):
        plugin.lees = lambda ctx, max_oud_s=0: devs
        return plugin.blok({"installatie": "ins"}, "huis")
    def actie(self, devs, actie, antwoord):
        plugin.lees = lambda ctx, max_oud_s=0: devs
        return plugin.actie({"installatie": "ins"}, {"blok": "huis", "actie": actie, "antwoord": antwoord})

    def test_temperatuur_groot_en_kort(self):
        b = self.blok(HUIS)
        self.assertEqual({k: b[k] for k in ("titel", "waarde", "regels")},
                         {"titel": "Homey van de fam", "waarde": "20,5°", "regels": ["2 lampen aan", "Verwarming op 21°"]})
        self.assertEqual(b["schermen"][-1], {"soort": "waarde", "titel": "Homey van de fam", "waarde": "20,5°", "regel": "Verwarming op 21°"})

    def test_lijst_met_schakelaars_zonder_favorieten(self):
        lijst = self.blok(HUIS)["schermen"][0]
        self.assertEqual(lijst["soort"], "lijst")
        self.assertEqual(lijst["rijen"], [{"tekst": "Hal", "pictogram": "lamp", "aan": False, "actie": "s-l3"},
                                          {"tekst": "Plafond", "pictogram": "lamp", "aan": True, "actie": "s-l1"},
                                          {"tekst": "Spots", "pictogram": "lamp", "aan": True, "actie": "s-l2"}])

    def test_favorieten_en_flows_als_knoppen(self):
        self.me = {"favoriteDevices": ["s", "l1", "weg"], "favoriteFlows": ["f1", "f2", "f3"]}
        self.flows = {"f1": {"id": "f1", "name": "Thuiskomen"}, "f2": {"id": "f2", "name": "Alles uit en naar bed"},
                      "f3": {"id": "f3", "name": "Uit", "enabled": False}}
        b = self.blok(HUIS)
        self.assertEqual([s["soort"] for s in b["schermen"]], ["lijst", "knoppen", "waarde"])
        self.assertEqual(b["schermen"][0]["rijen"], [{"tekst": "Voordeur", "pictogram": "slot", "waarde": "op slot"},
                                                     {"tekst": "Plafond", "pictogram": "lamp", "aan": True, "actie": "s-l1"}])
        self.assertEqual(b["schermen"][1]["knoppen"], [{"tekst": "Thuiskomen", "pictogram": "ster", "actie": "f-f1"},
                                                       {"tekst": "Alles uit…", "pictogram": "ster", "actie": "f-f2"}])

    def test_zonder_favoriete_flows_de_sferen(self):
        self.moods = {"m2": {"id": "m2", "name": "Avond"}, "m1": {"id": "m1", "name": "Film kijken"}}
        kn = self.blok(HUIS)["schermen"][1]
        self.assertEqual(kn, {"soort": "knoppen", "titel": "Sferen", "knoppen": [{"tekst": "Avond", "pictogram": "lamp", "actie": "m-m2"},
                                                                               {"tekst": "Film kijk…", "pictogram": "lamp", "actie": "m-m1"}]})
        self.assertEqual(self.actie(HUIS, "m-m2", "tik"), "Sfeer Avond aan")
        self.assertEqual(self.aanroepen[-1], ("/moods/mood/m2/set", "POST", {}))

    def test_garage_open_is_een_vraag(self):
        b = self.blok(HUIS + [dev("Gar-1", "Garage", "garagedoor", garagedoor_closed=False)])
        v = b["schermen"][0]
        self.assertEqual(v, {"soort": "vraag", "titel": "Garage", "vraag": {"tekst": "Garage staat open. Dicht doen?", "uitleg": "Garagedeur",
                                                         "ja": "Dicht", "nee": "Laat", "actie": "g-gar1"}})

    def test_acties(self):
        g = dev("Gar-1", "Garage", "garagedoor", garagedoor_closed=False)
        self.assertEqual(self.actie(HUIS, "s-l3", "aan"), "Hal aan")
        self.assertEqual(self.aanroepen[-1], ("/devices/device/l3/capability/onoff", "PUT", {"value": True}))
        self.assertEqual(self.actie(HUIS + [g], "g-gar1", "nee"), "Garage blijft open")
        self.assertEqual(self.actie(HUIS + [g], "g-gar1", "ja"), "Garage gaat dicht")
        self.assertEqual(self.aanroepen[-1], ("/devices/device/Gar-1/capability/garagedoor_closed", "PUT", {"value": True}))
        self.flows = {"f1": {"id": "f1", "name": "Thuiskomen"}}
        self.assertEqual(self.actie(HUIS, "f-f1", "tik"), "Thuiskomen gestart")
        self.assertEqual(self.aanroepen[-1], ("/flow/flow/f1/trigger", "POST", {}))
        n = len(self.aanroepen)
        self.assertEqual(self.actie(HUIS, "s-s", "uit"), "Dat kan hier niet")          # een slot is geen schakelaar
        self.assertEqual(self.actie(HUIS, "s-weg", "aan"), "Dat apparaat vind ik niet meer")
        self.assertEqual(len(self.aanroepen), n)

    def test_alles_past_op_het_scherm(self):
        self.me = {"favoriteDevices": [d["id"] for d in HUIS]}
        b = self.blok(HUIS + [dev("g", "Een heel lange naam voor de garagedeur", "garagedoor", garagedoor_closed=False)])
        self.assertLessEqual(len(b["schermen"]), 4)
        for s in b["schermen"]:
            for r in s.get("rijen", []): self.assertLessEqual(len(r["tekst"]), 10 if "aan" in r else 24)
            for k in s.get("knoppen", []): self.assertLessEqual(len(k["tekst"]), 10)
            if "vraag" in s: self.assertLessEqual(len(s["vraag"]["tekst"]), 60)
            for x in [s.get("vraag", {}).get("actie")] + [r.get("actie") for r in s.get("rijen", [])]:
                if x: self.assertRegex(x, r"^[a-z0-9-]{1,32}$")

    def test_zonder_thermostaat_de_lampen(self):
        self.assertEqual(self.blok(HUIS[1:])["waarde"], "2 lampen")
        b = self.blok([HUIS[3]])
        self.assertEqual(b["waarde"], "")                       # niets om groot te tonen: een lijst
        self.assertEqual(b["regels"], ["Alle lampen uit"])

    def test_eerst_wat_aandacht_vraagt(self):
        b = self.blok(HUIS + [dev("g", "Garage", "garagedoor", garagedoor_closed=False), dev("s2", "Achterdeur", "lock", locked=False)])
        self.assertEqual(b["regels"][:3], ["Achterdeur: niet op slot", "Garage: open", "2 lampen aan"])
        self.assertNotIn("melding", b)

    def test_melding_bij_rook(self):
        b = self.blok(HUIS + [dev("r1", "Rookmelder keuken", "sensor", alarm_smoke=True), dev("w", "Wasmachine", "sensor", alarm_water=True)])
        self.assertEqual(b["regels"][:2], ["Rookmelder keuken: alarm", "Wasmachine: alarm"])
        m = b["melding"]
        self.assertEqual(m, {"id": "alarm_smoke-r1", "titel": "Rookmelder thuis gaat af", "icoon": "warn", "kleur": "gevaar", "geluid": "SFX_MSG"})
        self.assertIn(m["icoon"], NAMEN["iconen"]); self.assertIn(m["kleur"], NAMEN["kleuren"]); self.assertIn(m["geluid"], NAMEN["geluiden"])
        for _, titel in plugin.ALARMEN: self.assertLessEqual(len(titel.encode()), 27)
        self.assertNotIn("melding", self.blok(HUIS + [dev("r1", "Rookmelder keuken", "sensor", alarm_smoke=False)]))

    def test_niet_gekoppeld(self):
        def niet(ctx, max_oud_s=0): raise plugin.NietGekoppeld()
        plugin.lees = niet
        b = plugin.blok({"installatie": "ander"}, "huis")
        self.assertEqual((b["waarde"], b["regels"]), ("", ["Nog niet gekoppeld", "Koppel eerst: Menu > Apps"]))
        self.assertEqual(b["kaarten"][0]["titel"], "Nog niet gekoppeld")

if __name__ == "__main__":
    unittest.main()
