"""Tests zonder netwerk: het scherm van de Reisgids-app op Bolle. Draaien: python3 -m unittest discover -s test"""
import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import plugin

PLEKKEN = {"query": {"pages": [
    {"title": "Dom van Utrecht", "length": 90000, "description": "kerk", "coordinates": [{"lat": 52.0909, "lon": 5.1214}]},
    {"title": "Zadelstraat 19", "length": 99999, "coordinates": [{"lat": 52.09, "lon": 5.12}]},
    {"title": "Kasteel de Haar", "length": 50000, "coordinates": [{"lat": 52.1214, "lon": 4.9844}]},
    {"title": "Utrecht (stad)", "length": 120000, "coordinates": [{"lat": 52.09, "lon": 5.11}]}]}}

class Blok(unittest.TestCase):
    def setUp(self): self.oud = plugin.api
    def tearDown(self): plugin.api = self.oud
    def blok(self, antwoord, ctx={"locatie": {"lat": 52.09, "lon": 5.12}}):
        plugin.api = lambda **q: antwoord
        return plugin.blok(ctx, "buurt")

    def test_kaarten_zoals_het_nieuws(self):
        b = self.blok(PLEKKEN)
        self.assertEqual(b["soort"], "kaarten")
        self.assertEqual(b["waarde"], "")
        self.assertNotIn("meter", b)
        self.assertEqual(b["kaarten"][1], {"titel": "Dom van Utrecht", "tekst": "dichtbij · kerk", "bron": "Wikipedia"})
        self.assertEqual([k["titel"] for k in b["kaarten"]], ["Utrecht (stad)", "Dom van Utrecht", "Kasteel de Haar"])
        for k in b["kaarten"]: self.assertTrue(len(k["titel"]) <= 60 and len(k.get("tekst", "")) <= 70 and len(k["bron"]) <= 24)
        self.assertEqual(b["regels"], ["Utrecht (stad) · dichtbij", "Dom van Utrecht · dichtbij", "Kasteel de Haar · 10 km", "Bron: Wikipedia"])
        self.assertLessEqual(len(b["regels"]), 5)

    def test_niets_en_geen_gps(self):
        b = self.blok({"query": {"pages": []}})
        self.assertEqual(b["regels"], ["Niets bekends binnen 5 km", "Bron: Wikipedia"])
        self.assertEqual(b["kaarten"], [{"titel": "Niets bekends binnen 5 km", "tekst": "Bron: Wikipedia"}])
        self.assertEqual(self.blok(PLEKKEN, {})["regels"], ["Geen GPS: plek onbekend"])

if __name__ == "__main__":
    unittest.main()
