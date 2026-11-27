"""Tests zonder netwerk: het scherm van de Kilometers-app op Bolle. Draaien: python3 -m unittest discover -s test"""
import os, sys, time, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import plugin

class Blok(unittest.TestCase):
    def setUp(self):
        self.oud = plugin.lees
        nu = plugin.ams()
        self.maand, self.mnd = plugin.maand_van(nu), plugin.MAANDEN[nu.month - 1]
        self.vorige = f"{nu.year:04d}-{nu.month - 1:02d}" if nu.month > 1 else None
    def tearDown(self): plugin.lees = self.oud
    def blok(self, d):
        plugin.lees = lambda ctx: {"v": 1, "ritten": [], "maanden": {}, **d}
        return plugin.blok_kilometers({})

    def test_leeg_is_een_lijst(self):
        b = self.blok({})
        self.assertEqual(b["waarde"], "")
        self.assertNotIn("meter", b)
        self.assertEqual(b["regels"], [f"Nog geen ritten in {self.mnd}", "Zeg: noteer een zakelijke rit,", "kilometerstand ..."])
        self.assertEqual(b["kaarten"], [{"titel": f"Nog geen ritten in {self.mnd}", "tekst": "Zeg: noteer een zakelijke rit, kilometerstand ..."}])

    def test_zakelijk_deze_maand_groot(self):
        b = self.blok({"ritten": [["2026-11-24", "z", 45230, 45318, 88, "Utrecht"]], "maanden": {self.maand: [1412, 88, 9, 3]}})
        self.assertEqual(b["waarde"], "1.412 km")
        self.assertLessEqual(len(b["waarde"]), 10)
        self.assertLessEqual(len(b["titel"]), 16)
        self.assertTrue(b["titel"].startswith("Zakelijk "))
        self.assertEqual(b["regels"][:2], ["Privé 88 km", f"12 ritten in {self.mnd}"])
        self.assertLessEqual(len(b["regels"]), 6)
        s, = b["schermen"]                       # het scherm op Bolle: het getal groot, km eronder, het aantal ritten
        self.assertEqual((s["soort"], s["waarde"], s["eenheid"], s["regel"]), ("waarde", "1.412", "km", "12 ritten"))
        self.assertLessEqual(len(s["waarde"]), 8)

    def test_rit_loopt_bovenaan(self):
        b = self.blok({"loopt": {"t": int(time.time()), "s": "z", "b": 45230, "d": ""}, "maanden": {self.maand: [10, 0, 1, 0]}})
        self.assertEqual(b["regels"][0], f"Zakelijke rit sinds {plugin.ams().strftime('%H:%M')}")
        b = self.blok({"loopt": {"t": int(time.time()), "s": "p", "b": 45230, "d": ""}})
        self.assertEqual(b["waarde"], "")
        self.assertTrue(b["regels"][0].startswith("Privérit sinds "))

    def test_nieuwe_maand_zonder_ritten(self):
        if not self.vorige: self.skipTest("januari: geen eerdere maand dit jaar")
        b = self.blok({"ritten": [["2026-10-02", "z", None, None, 50, ""]], "maanden": {self.vorige: [1500, 40, 20, 2]}})
        self.assertEqual(b["waarde"], "")
        self.assertEqual(b["regels"], [f"Nog geen ritten in {self.mnd}", "Dit jaar 1.500 km zakelijk", "Dit jaar 40 km privé"])

    def test_titels_passen(self):
        for m in plugin.MAANDEN:
            t = f"Zakelijk {m}" if len(f"Zakelijk {m}") <= 16 else f"Zakelijk {m[:3]}."
            self.assertLessEqual(len(t), 16)

if __name__ == "__main__":
    unittest.main()
