"""App Reisgids (protocol 1.0 van het platform): wat er te zien is bij je plek, met een kort verhaal, uit Wikipedia.

Voorbeeld van een app die een gratis dienst op internet gebruikt. Het platform geeft de app alleen uitgaand
verkeer via een proxy naar de hosts in app.yaml (netwerk.uitgaand); urllib gebruikt HTTPS_PROXY vanzelf.

POST /mcp         tools/list | tools/call   (de broker zet "context" in het verzoek: locatie, afgerond op 2 decimalen)
POST /blok/buurt  het scherm op Bolle (een lijst)
GET  /gezond
"""
import json, math, os, re, threading, time, urllib.parse, urllib.request
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

WIKI = "https://nl.wikipedia.org"
KOP = {"User-Agent": "openBolle-app-reisgids/1.0 (https://openbolle.nl; plugins@openbolle.nl)"}   # vraagt Wikimedia
_cache, _slot = {}, threading.Lock()

def haal(url, ttl=3600):
    """Kleine cache in het geheugen (Wikipedia verandert niet per minuut); de app bewaart verder niets."""
    with _slot:
        t = _cache.get(url)
        if t and time.time() - t[0] < ttl: return t[1]
    with urllib.request.urlopen(urllib.request.Request(url, headers=KOP), timeout=3) as r:
        d = json.loads(r.read(400_000))
    with _slot:
        if len(_cache) > 300: _cache.clear()
        _cache[url] = (time.time(), d)
    return d

def api(**q): return haal(f"{WIKI}/w/api.php?" + urllib.parse.urlencode({"format": "json", "formatversion": 2, **q}))

def plek(ctx):
    loc = ctx.get("locatie")
    if not loc: raise LookupError("geen plek")
    return round(float(loc["lat"]), 2), round(float(loc["lon"]), 2)

def afstand(lat1, lon1, lat2, lon2):
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2)); y = math.radians(lat2 - lat1)
    return 6371 * math.hypot(x, y)

def km(x):                                       # de plek is op ca. 1 km afgerond: kleinere afstanden zeggen niets
    return "dichtbij" if x < 1.5 else f"{round(x)} km"

ADRES = re.compile(r"\d+[a-z]?$|\(\d+\)$")      # "Zadelstraat 19": losse rijksmonumenten zijn zelden wat je zoekt

def buurt(ctx, straal_km=5.0, n=5):
    """De belangrijkste artikelen met coördinaten in de buurt: uitgebreidste artikel eerst."""
    lat, lon = plek(ctx)
    d = api(action="query", generator="geosearch", ggscoord=f"{lat}|{lon}", ggsradius=int(straal_km * 1000), ggslimit=60,
            prop="info|description|coordinates")
    ps = [p for p in (d.get("query") or {}).get("pages", []) if p.get("coordinates") and not ADRES.search(p["title"])]
    for p in ps: p["afstand"] = afstand(lat, lon, p["coordinates"][0]["lat"], p["coordinates"][0]["lon"])
    ps.sort(key=lambda p: -p.get("length", 0))
    return ps[:n]

def regel(p):
    om = p.get("description") or ""
    return f"{p['title']} ({km(p['afstand'])})" + (f": {om}" if om else "")

def in_de_buurt(ctx, a):
    try: ps = buurt(ctx, max(1.0, min(float(a.get("km") or 5), 10)))
    except LookupError: return "Bolle weet nu niet waar hij is (geen GPS). Zeg dat kort."
    if not ps: return "Er staat niets bekends op Wikipedia binnen deze afstand."
    return "; ".join(regel(p) for p in ps) + ". Hemelsbreed, vanaf je plek op ca. 1 km nauwkeurig. Noem er een paar kort."

def samenvatting(titel):
    d = haal(f"{WIKI}/api/rest_v1/page/summary/" + urllib.parse.quote(titel.replace(" ", "_"), safe=""), 86400)
    return d.get("title") or titel, (d.get("extract") or "").strip()

def vertel_over(ctx, a):
    onderwerp = str(a.get("onderwerp") or "").strip()[:120]
    if not onderwerp:
        try: ps = buurt(ctx, 5, 1)
        except LookupError: return "Bolle weet nu niet waar hij is, en er is geen onderwerp genoemd. Vraag waarover."
        if not ps: return "Er staat niets bekends op Wikipedia in de buurt."
        titel = ps[0]["title"]
    else:
        r = api(action="query", list="search", srsearch=onderwerp, srlimit=1, srprop="")
        hits = (r.get("query") or {}).get("search") or []
        if not hits: return f"Op Wikipedia staat niets over '{onderwerp}'."
        titel = hits[0]["title"]
    titel, tekst = samenvatting(titel)
    if not tekst: return f"Over {titel} staat geen samenvatting op Wikipedia."
    return f"{titel}: {tekst[:1200]} (Bron: Wikipedia.) Vertel het kort en in je eigen woorden, in twee of drie zinnen."

TOOLS = {"in_de_buurt": in_de_buurt, "vertel_over": vertel_over}

def blok(ctx, bid):
    """Het scherm op Bolle (BolleOS 1.2): kaarten, zoals het nieuws. Eén plek per kaart (vegen voor de volgende), met
    de afstand, een korte omschrijving en de bron. De regels leest de assistent voor (en een oudere Bolle toont ze)."""
    def een(titel, tekst=None):
        return {"soort": "kaarten", "titel": "In de buurt", "kaarten": [{"titel": titel, **({"tekst": tekst} if tekst else {})}]}
    try: ps = buurt(ctx, 5, 4)
    except LookupError: return {**een("Plek onbekend", "Bolle heeft nog geen GPS"), "waarde": "", "regels": ["Geen GPS: plek onbekend"]}
    if not ps: return {**een("Niets bekends binnen 5 km", "Bron: Wikipedia"), "waarde": "", "regels": ["Niets bekends binnen 5 km", "Bron: Wikipedia"]}
    kaarten = [{"titel": p["title"][:60], "tekst": (km(p["afstand"]) + (f" · {p['description']}" if p.get("description") else ""))[:70],
                "bron": "Wikipedia"} for p in ps]
    return {"soort": "kaarten", "titel": "In de buurt", "waarde": "", "kaarten": kaarten,
            "regels": [f"{p['title']} · {km(p['afstand'])}" for p in ps] + ["Bron: Wikipedia"]}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass                      # geen plekken of vragen in de log
    def send(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        self.send(200, {"ok": True}) if self.path == "/gezond" else self.send(404, {})
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 65536: return self.send(413, {})
        try: rq = json.loads(self.rfile.read(n) or b"{}")
        except ValueError: return self.send(400, {})
        if self.path.startswith("/blok/"):
            try: return self.send(200, blok(rq.get("context") or {}, self.path[6:]))
            except Exception as e: return self.send(200, {"titel": "In de buurt", "waarde": "", "regels": [f"Nu niet op te halen ({type(e).__name__})."]})
        if self.path != "/mcp": return self.send(404, {})
        rid, p = rq.get("id"), rq.get("params") or {}
        if rq.get("method") == "tools/list":
            return self.send(200, {"jsonrpc": "2.0", "id": rid, "result": {"tools": [{"name": n} for n in TOOLS]}})
        if rq.get("method") == "tools/call" and p.get("name") in TOOLS:
            try: tekst, fout = TOOLS[p["name"]](rq.get("context") or {}, p.get("arguments") or {}), False
            except Exception as e: tekst, fout = f"Wikipedia is nu niet te bereiken ({type(e).__name__}).", True
            return self.send(200, {"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": tekst}], "isError": fout}})
        self.send(200, {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "onbekend"}})

if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("POORT") or 8080)), H).serve_forever()
