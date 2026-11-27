"""Sjabloon voor een openBolle-app (protocol 1.0 van het platform): een HTTP-server op poort 8080 (of POORT uit de omgeving).

De broker stuurt per aanroep een JSON-RPC-verzoek naar POST /mcp, met een "context" erbij:
  installatie (pseudoniem), instellingen, locatie (alleen met locatie:*), rijdt (alleen met rit:status),
  aanroep_token (voor de terugroep-API van de broker: http://plugins:8000/plugin/v1/...).
Het scherm van je app vraagt de broker op met POST /blok/<id> (blok v2, BolleOS 1.2): zie blok_hallo en de helpers
waarde(), kaarten(), vraag(), lijst(), knoppen() en schermen() hieronder.
Tikt iemand op een knop, een rij of een antwoord op een vraag, dan komt dat binnen op POST /actie (recht
vragen:stellen): zie actie().
De app bewaart zelf niets (alleen-lezen schijf); gebruik de opslag van de broker als je iets moet onthouden.
"""
import json, os, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

# ---------------------------------------------------------------- schermen maken
# Een app tekent niets zelf. Hij kiest een soort scherm, elk een kopie van een scherm van Bolle (docs: Schermen):
#   waarde   een groot getal met hooguit twee ringen, zoals de snelheid (waarde ≤ 8 tekens als getal, anders 10;
#            eenheid ≤ 10; regel ≤ 24; meter en meter2 0..100; één knop)
#   kaarten  één kaart per scherm, zoals nieuws (≤ 8 kaarten; titel ≤ 60, tekst ≤ 70, bron ≤ 24; per kaart één knop)
#   vraag    ja of nee, zoals "Nog er?" (tekst en uitleg ≤ 60, ja en nee ≤ 10)
#   lijst    rijen zoals het menu, met een waarde of een schakelaar (≤ 6 rijen; tekst ≤ 24, met schakelaar ≤ 10)
#   knoppen  2 tot 4 vlakken rond het midden, zoals Ottie verzorgen (tekst ≤ 10)
# Een actie is a-z, 0-9 en -, hooguit 32 tekens. Pictogrammen: de namen uit app.schema.json (bliksem, slot, lamp, ...).
# kleur ("#RRGGBB") is je eigen kleur: ring, ja-helft, knoppen, schakelaars, puntjes en de bevestiging.
# regels (≤ 6) leest de assistent voor; ze staan niet op het scherm.

def knop(tekst, actie, pictogram=None):
    return {"tekst": tekst, "actie": actie, **({"pictogram": pictogram} if pictogram else {})}

def waarde(titel, w, **rest):
    """waarde("Tesla", "78%", meter=78, regel="312 km bereik", knop=knop("Laden", "laden-start", "bliksem"))"""
    return {"soort": "waarde", "titel": titel, "waarde": w, **rest}

def kaarten(titel, k, **rest):
    """kaarten("In de buurt", [{"titel": "Domtoren", "tekst": "0,4 km", "bron": "Wikipedia"}])"""
    return {"soort": "kaarten", "titel": titel, "kaarten": k, **rest}

def vraag(titel, tekst, actie, uitleg=None, ja=None, nee=None, **rest):
    v = {"tekst": tekst, "actie": actie, **{k: x for k, x in (("uitleg", uitleg), ("ja", ja), ("nee", nee)) if x}}
    return {"soort": "vraag", "titel": titel, "vraag": v, **rest}

def lijst(titel, rijen, **rest):
    """lijst("Thuis", [{"tekst": "Woonkamer", "pictogram": "lamp", "aan": True, "actie": "lamp-1"}])"""
    return {"soort": "lijst", "titel": titel, "rijen": rijen, **rest}

def knoppen(titel, k, **rest):
    """knoppen("Auto", [knop("Slot", "slot", "slot"), knop("Klimaat", "klimaat", "thermometer")])"""
    return {"soort": "knoppen", "titel": titel, "knoppen": k, **rest}

def schermen(titel, s, **rest):
    """Tot 4 schermen; vegen gaat erdoor. blok, kleur, regels en melding horen bij het blok, niet bij een scherm."""
    return {"titel": titel, "schermen": s, **rest}

def alarm(titel, icoon, kleur=None, geluid=None, id=None):
    """Een alarm, zoals een flitser. kleur: info ok gevaar ernstig agenda telefoon (geen eigen kleur)."""
    return {"vorm": "alarm", "titel": titel, "icoon": icoon, **{k: x for k, x in (("kleur", kleur), ("geluid", geluid), ("id", id)) if x}}

def bericht(titel, tekst=None, kleur=None, id=None):
    """Een bericht, zoals WhatsApp: balk onderin met je naam en titel (≤ 23 bytes), tekst ≤ 70; daarna in Berichten."""
    return {"vorm": "bericht", "titel": titel, **{k: x for k, x in (("tekst", tekst), ("kleur", kleur), ("id", id)) if x}}

# ---------------------------------------------------------------- je app

def hallo(ctx, args):
    return f"Hallo {args.get('naam') or 'daar'}!"

def blok_hallo(ctx):
    """Het scherm van je app: hier een waarde (de tijd) met een ring en een knop. Probeer ook kaarten(), lijst() of
    schermen([...]) met meerdere schermen. Zonder waarde staat je app niet op het beginscherm."""
    nu = time.localtime()
    dag = round((nu.tm_hour * 60 + nu.tm_min) / 14.4)          # hoeveel procent van de dag voorbij is
    blok = waarde("Hallo", time.strftime("%H:%M", nu), meter=dag, regel=f"{dag}% van de dag",
                  knop=knop("Zeg hallo", "hallo", "ster"), blok="hallo",
                  regels=[f"Het is {time.strftime('%H:%M', nu)}", f"{dag}% van de dag is voorbij"])
    # Een melding uit zichzelf (rechten blokken:tonen en meldingen:sturen): zet hem in het blok zolang het speelt.
    # Bolle haalt de blokken elke 2 minuten op, ook tijdens het rijden; de broker stuurt elke melding één keer door.
    # Een nieuwe "id" (zonder id: een nieuwe titel) is een nieuwe melding. Namen van iconen en geluiden:
    # schema/bolleos.json. Hier alleen met de instelling proefmelding aan (in dev: Instellingen {"proefmelding": true}).
    if (ctx.get("instellingen") or {}).get("proefmelding"):
        blok["melding"] = alarm("Hallo van je app", "bell", kleur="info", geluid="SFX_MSG", id=time.strftime("proef-%Y%m%d%H", nu))
    return blok

def actie(ctx, a):
    """Een antwoord van Bolle (recht vragen:stellen): a = {"blok", "actie", "antwoord": ja|nee|tik|aan|uit}.
    Geef terug wat Bolle groot laat zien (hooguit 40 tekens), of {"tekst": ..., "melding": ...}. Komt nooit tijdens
    het rijden: dan weigert de broker al. Doe alleen wat je app echt kan."""
    if a.get("actie") == "hallo": return "Hallo!"
    return "Onbekende actie"

TOOLS = {"hallo": hallo}            # moet precies gelijk zijn aan de tools in app.yaml
BLOKKEN = {"hallo": blok_hallo}     # en dit aan de blokken in app.yaml

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass                      # geen gegevens van gebruikers in de log
    def stuur(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        self.stuur({"ok": True}) if self.path == "/gezond" else self.stuur({}, 404)
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 65536: return self.stuur({}, 413)
        try: rq = json.loads(self.rfile.read(n) or b"{}")
        except ValueError: return self.stuur({}, 400)
        if self.path.startswith("/blok/") and self.path[6:] in BLOKKEN:
            try: return self.stuur(BLOKKEN[self.path[6:]](rq.get("context") or {}))
            except Exception as e: return self.stuur({"titel": "", "waarde": "", "regels": [f"Nu niet op te halen ({type(e).__name__})."]})
        if self.path == "/actie":
            try: r = actie(rq.get("context") or {}, {k: str(rq.get(k) or "") for k in ("blok", "actie", "antwoord")})
            except Exception: r = "Dat lukte niet"
            return self.stuur(r if isinstance(r, dict) else {"tekst": r})
        if self.path != "/mcp": return self.stuur({}, 404)
        rid, p = rq.get("id"), rq.get("params") or {}
        if rq.get("method") == "tools/list":
            return self.stuur({"jsonrpc": "2.0", "id": rid, "result": {"tools": [{"name": n} for n in TOOLS]}})
        if rq.get("method") == "tools/call" and p.get("name") in TOOLS:
            # een tool geeft een tekst terug, of {"tekst": ..., "melding": alarm(...)}:
            # met het recht meldingen:sturen toont Bolle dat alarm na het antwoord, met geluid
            try: r, fout = TOOLS[p["name"]](rq.get("context") or {}, p.get("arguments") or {}), False
            except Exception as e: r, fout = f"Dat lukt nu niet ({type(e).__name__}).", True
            res = {"content": [{"type": "text", "text": r["tekst"] if isinstance(r, dict) else r}], "isError": fout}
            if isinstance(r, dict) and r.get("melding"): res["melding"] = r["melding"]
            return self.stuur({"jsonrpc": "2.0", "id": rid, "result": res})
        self.stuur({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "onbekend"}})

if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("POORT") or 8080)), H).serve_forever()
