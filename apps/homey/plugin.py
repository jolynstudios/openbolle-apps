"""App Homey (protocol 1.0 van het platform): je Homey Pro bedienen via de Web API van Athom.

Inloggen doet de broker (OAuth, QR-code op Bolle). Per aanroep:
  broker  GET /plugin/v1/oauth/token                -> kortlevend Athom-token
  Athom   GET  https://api.athom.com/user/me        -> je Homeys (remoteUrl)
          POST https://api.athom.com/delegation/token?audience=homey -> JWT
  Homey   POST <remoteUrl>/api/manager/users/login {"token": JWT}    -> sessie (bewaard in het geheugen, per installatie)
Internet loopt via de uitgang van het platform (HTTPS_PROXY), alleen naar de hosts in app.yaml.

POST /mcp         tools/list | tools/call
POST /blok/huis   het scherm op Bolle (BolleOS 1.2): je favoriete apparaten als lijst met schakelaars, een vraag als
                  de garagedeur open staat, je favoriete flows (of je sferen) als knoppen (en een melding uit zichzelf bij een alarm)
POST /actie       een tik op Bolle (recht vragen:stellen): een schakelaar, de vraag, een flow of een sfeer
GET  /gezond
"""
import json, os, re, threading, time, unicodedata, urllib.error, urllib.parse, urllib.request
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

BROKER = os.environ.get("BROKER_URL", "http://plugins:8000")
ATHOM = "https://api.athom.com"
sessies = {}                     # installatie -> (homey_url, sessie, naam)
slot = threading.Lock()
BEVEILIGING = {"lock", "garagedoor", "homealarm"}

class NietGekoppeld(Exception): pass

def _json(url, methode="GET", token=None, body=None, timeout=5):
    h = {"Accept": "application/json", "User-Agent": "openbolle-homey/1"}
    if token: h["Authorization"] = "Bearer " + token
    data = None
    if body is not None: data = json.dumps(body).encode(); h["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=data, method=methode, headers=h)
    with urllib.request.urlopen(r, timeout=timeout) as x:
        b = x.read()
        return json.loads(b) if b else None

def athom_token(ctx):
    r = urllib.request.Request(f"{BROKER}/plugin/v1/oauth/token", headers={"Authorization": "Bearer " + ctx["aanroep_token"]})
    try:
        with urllib.request.urlopen(r, timeout=8) as x: return json.load(x)["access_token"]
    except urllib.error.HTTPError as e:
        if e.code == 409: raise NietGekoppeld()
        raise

def sessie(ctx, opnieuw=False):
    iid = ctx["installatie"]
    with slot:
        if not opnieuw and iid in sessies: return sessies[iid]
    tok = athom_token(ctx)
    me = _json(f"{ATHOM}/user/me", token=tok)
    homeys = [h for h in me.get("homeys") or [] if h.get("remoteUrl")]
    if not homeys: raise RuntimeError("geen Homey bereikbaar via internet")
    h = homeys[0]
    jwt = _json(f"{ATHOM}/delegation/token?audience=homey", "POST", tok, {})
    s = _json(h["remoteUrl"].rstrip("/") + "/api/manager/users/login", "POST", body={"token": jwt})
    with slot: sessies[iid] = (h["remoteUrl"].rstrip("/"), s, h.get("name") or "Homey")
    return sessies[iid]

def homey(ctx, pad, methode="GET", body=None):
    """Aanroep op de Homey; bij een verlopen sessie één keer opnieuw inloggen."""
    for poging in (0, 1):
        url, s, _ = sessie(ctx, opnieuw=bool(poging))
        try: return _json(url + "/api/manager" + pad, methode, s, body, timeout=6)
        except urllib.error.HTTPError as e:
            if e.code != 401 or poging: raise

def norm(t):
    t = unicodedata.normalize("NFKD", str(t or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"\b(de|het|een|alle|lamp|lampen|licht|lichten|in|op)\b", " ", re.sub(r"[^a-z0-9 ]", " ", t)).split()

def stand(d):
    c = {k: (v or {}).get("value") for k, v in (d.get("capabilitiesObj") or {}).items()}
    s = []
    if "onoff" in c: s.append("aan" if c["onoff"] else "uit")
    if c.get("dim") is not None and c.get("onoff"): s.append(f"{round(c['dim'] * 100)}%")
    if c.get("measure_temperature") is not None: s.append(f"{c['measure_temperature']:.1f} graden".replace(".", ","))
    if c.get("target_temperature") is not None: s.append(f"ingesteld op {c['target_temperature']:g}".replace(".", ","))
    if "locked" in c: s.append("op slot" if c["locked"] else "NIET op slot")
    if "garagedoor_closed" in c: s.append("dicht" if c["garagedoor_closed"] else "OPEN")
    if c.get("homealarm_state"): s.append({"armed": "alarm aan", "disarmed": "alarm uit", "partially_armed": "alarm deels aan"}.get(c["homealarm_state"], c["homealarm_state"]))
    if c.get("alarm_contact"): s.append("open")
    return ", ".join(s)

_lees_cache = {}   # installatie -> (tijd, apparaten); de lijst is groot (honderden KB via de cloud van Athom)
_zone_cache = {}   # installatie -> (tijd, {id: naam}); kamers veranderen zelden

def lees(ctx, max_oud_s=0):
    """Alle apparaten met hun kamer. Tools vragen vers (0 s); de tegel neemt een lijst van hooguit max_oud_s oud."""
    iid = ctx.get("installatie")
    t = _lees_cache.get(iid)
    if t and max_oud_s and time.time() - t[0] < max_oud_s: return t[1]
    devs = list((homey(ctx, "/devices/device") or {}).values())
    z = _zone_cache.get(iid)
    if not z or time.time() - z[0] > 600:
        z = _zone_cache[iid] = (time.time(), {x["id"]: x["name"] for x in (homey(ctx, "/zones/zone") or {}).values()})
    for d in devs: d["_kamer"] = z[1].get(d.get("zone"), "")
    _lees_cache[iid] = (time.time(), devs)
    return devs

def zoek(devs, naam, filter=None):
    """Apparaten die bij naam passen: exacte naam, anders een kamer, anders alle woorden in naam+kamer."""
    devs = [d for d in devs if not filter or filter(d)]
    q = norm(naam)
    if not q: return [], False
    exact = [d for d in devs if norm(d["name"]) == q]
    if exact: return exact, False
    kamer = [d for d in devs if norm(d["_kamer"]) == q]
    if kamer: return kamer, True
    los = [d for d in devs if all(w in norm(d["name"] + " " + d["_kamer"]) for w in q)]
    return los, False

def apparaten(ctx, a):
    devs = lees(ctx)
    k = norm(a.get("kamer"))
    if k: devs = [d for d in devs if all(w in norm(d["_kamer"]) for w in k)]
    devs = [d for d in devs if stand(d)]
    if not devs: return "Geen apparaten gevonden" + (f" in {a['kamer']}." if k else ".")
    per = {}
    for d in sorted(devs, key=lambda d: (d["_kamer"], d["name"])): per.setdefault(d["_kamer"] or "zonder kamer", []).append(f"{d['name']} {stand(d)}")
    return " | ".join(f"{kamer}: " + "; ".join(l) for kamer, l in per.items())

def bedien(ctx, a):
    actie = a.get("actie")
    devs = lees(ctx)
    if actie == "temperatuur":
        thermo = [d for d in devs if "target_temperature" in (d.get("capabilitiesObj") or {})]
        kies, _ = zoek(thermo, a.get("apparaat"))
        if not kies and len(thermo) == 1: kies = thermo          # "de verwarming" met maar één thermostaat
        cap, waarde = "target_temperature", float(a.get("waarde") or 0)
        if not 5 <= waarde <= 30: return "Geef een temperatuur tussen 5 en 30 graden."
    else:
        kies, kamer = zoek(devs, a.get("apparaat"), lambda d: d.get("class") not in BEVEILIGING and
                           ("onoff" in (d.get("capabilitiesObj") or {}) or "dim" in (d.get("capabilitiesObj") or {})))
        if kamer: kies = [d for d in kies if d.get("class") in ("light", "socket")] or kies
        if actie == "dimmen":
            cap, waarde = "dim", max(0.0, min(1.0, float(a.get("waarde") or 0) / 100))
            kies = [d for d in kies if "dim" in (d.get("capabilitiesObj") or {})]
        else: cap, waarde = "onoff", actie == "aan"
    if not kies: return f"Ik vind geen apparaat '{a.get('apparaat')}' dat dit kan. Vraag eventueel welke apparaten er zijn."
    if len(kies) > 8: return f"Dat zijn {len(kies)} apparaten; noem een kamer of een preciezere naam."
    gelukt = []
    for d in kies:
        try: homey(ctx, f"/devices/device/{d['id']}/capability/{cap}", "PUT", {"value": waarde}); gelukt.append(d["name"])
        except Exception: pass
    if not gelukt: return "Dat lukte niet; de Homey weigerde het."
    wat = {"onoff": "aan" if waarde is True else "uit", "dim": f"op {round(waarde * 100)}%", "target_temperature": f"op {waarde:g} graden"}[cap]
    return f"Gedaan: {', '.join(gelukt)} {wat}."

def beveiliging(ctx, a):
    actie = a.get("actie")
    caps = {"op_slot": ("locked", True), "van_slot": ("locked", False), "dicht": ("garagedoor_closed", True),
            "open": ("garagedoor_closed", False), "alarm_aan": ("homealarm_state", "armed"), "alarm_uit": ("homealarm_state", "disarmed")}
    if actie not in caps: return "Onbekende actie."
    cap, waarde = caps[actie]
    kies, _ = zoek(lees(ctx), a.get("apparaat"), lambda d: cap in (d.get("capabilitiesObj") or {}))
    if len(kies) != 1: return "Ik weet niet precies welk apparaat je bedoelt; noem de naam zoals in Homey." if kies else "Dat apparaat vind ik niet."
    homey(ctx, f"/devices/device/{kies[0]['id']}/capability/{cap}", "PUT", {"value": waarde})
    return f"Gedaan: {kies[0]['name']} {actie.replace('_', ' ')}."

def flows(ctx):
    uit = []
    for pad, soort in (("/flow/flow", "flow"), ("/flow/advancedflow", "advancedflow")):
        try: lijst = (homey(ctx, pad) or {}).values()
        except urllib.error.HTTPError: continue
        uit += [(f, soort) for f in lijst if f.get("enabled", True) and f.get("triggerable", True)]
    return uit

def flow_starten(ctx, a):
    fl = flows(ctx)
    if not a.get("naam"):
        return "Flows die je kunt starten: " + ", ".join(sorted(f["name"] for f, _ in fl)[:30]) if fl else "Er zijn geen flows om te starten."
    q = norm(a["naam"])
    kies = [x for x in fl if norm(x[0]["name"]) == q] or [x for x in fl if all(w in norm(x[0]["name"]) for w in q)]
    if not kies: return f"Ik vind geen flow '{a['naam']}'."
    if len(kies) > 1: return "Welke bedoel je: " + ", ".join(f["name"] for f, _ in kies[:6]) + "?"
    f, soort = kies[0]
    homey(ctx, f"/flow/{soort}/{f['id']}/trigger", "POST", {})
    return f"Flow '{f['name']}' gestart."

def sfeer(ctx, a):
    moods = list((homey(ctx, "/moods/mood") or {}).values())
    if not a.get("naam"):
        return "Sferen: " + ", ".join(m["name"] for m in moods) if moods else "Er zijn geen sferen ingesteld."
    q = norm(a["naam"])
    kies = [m for m in moods if norm(m["name"]) == q] or [m for m in moods if all(w in norm(m["name"]) for w in q)]
    if len(kies) != 1: return "Welke sfeer bedoel je: " + ", ".join(m["name"] for m in (kies or moods)[:6]) + "?"
    homey(ctx, f"/moods/mood/{kies[0]['id']}/set", "POST", {})
    return f"Sfeer '{kies[0]['name']}' staat aan."

TOOLS = {"apparaten": apparaten, "bedien": bedien, "beveiliging": beveiliging, "flow_starten": flow_starten, "sfeer": sfeer}
KOPPELEN = "Homey is nog niet gekoppeld. Zeg: open op Bolle Menu, Apps, Homey, en scan de QR-code met je telefoon."

# Alarmen in huis die Bolle uit zichzelf meldt (recht meldingen:sturen), het ernstigste eerst: capability -> titel
ALARMEN = [("alarm_fire", "Brandalarm thuis"), ("alarm_smoke", "Rookmelder thuis gaat af"),
           ("alarm_co", "Koolmonoxide thuis"), ("alarm_heat", "Hittealarm thuis"), ("alarm_water", "Waterlek thuis")]

def caps(d): return {k: (v or {}).get("value") for k, v in (d.get("capabilitiesObj") or {}).items()}

def alarmen(devs):
    """[(capability, titel, apparaat)] van de alarmen die nu afgaan, het ernstigste eerst."""
    return [(cap, titel, d) for cap, titel in ALARMEN for d in sorted(devs, key=lambda d: d.get("id") or "") if caps(d).get(cap) is True]

# ---------------------------------------------------------------- het scherm op Bolle (blok v2) en de acties
PICTO = {"light": "lamp", "socket": "stekker", "thermostat": "thermometer", "heater": "thermometer", "lock": "slot",
         "garagedoor": "garage", "fan": "instellingen", "tv": "info", "speaker": "muziek", "sensor": "info"}

def kort_id(d):
    """Een kort stuk van het apparaat- of flow-id voor in een actie (a-z, 0-9: hooguit 32 tekens met het voorvoegsel)."""
    return re.sub(r"[^a-z0-9]", "", str(d.get("id") or "").lower())[:12]

def kort_tekst(t, n):
    t = str(t or "")
    return t if len(t) <= n else t[:n - 1] + "…"

_gebruiker_cache = {}   # installatie -> (tijd, properties van de ingelogde gebruiker: favoriete apparaten en flows)
_flow_cache = {}        # installatie -> (tijd, [(flow, soort)])

def favorieten(ctx):
    """De favoriete apparaten en flows van de gebruiker in de Homey-app (users/user/me). Geeft ([], []) als de Homey
    ze niet geeft: dan kiezen we zelf (lampen en stekkers)."""
    iid = ctx.get("installatie")
    t = _gebruiker_cache.get(iid)
    if not t or time.time() - t[0] > 600:
        try: pr = (homey(ctx, "/users/user/me") or {}).get("properties") or {}
        except Exception: pr = {}
        t = _gebruiker_cache[iid] = (time.time(), pr)
    pr = t[1]
    lijst = lambda x: [str(i) for i in x if isinstance(i, str)] if isinstance(x, list) else []
    return lijst(pr.get("favoriteDevices")), lijst(pr.get("favoriteFlows"))

def flows_kort(ctx):
    iid = ctx.get("installatie")
    t = _flow_cache.get(iid)
    if not t or time.time() - t[0] > 600: t = _flow_cache[iid] = (time.time(), flows(ctx))
    return t[1]

_mood_cache = {}        # installatie -> (tijd, [sfeer])

def moods_kort(ctx):
    iid = ctx.get("installatie")
    t = _mood_cache.get(iid)
    if not t or time.time() - t[0] > 600:
        t = _mood_cache[iid] = (time.time(), sorted((homey(ctx, "/moods/mood") or {}).values(), key=lambda m: m.get("name") or ""))
    return t[1]

def rij(d):
    """Een rij in de lijst: een schakelaar voor wat aan of uit kan (geen beveiliging), anders de stand om te lezen."""
    c = caps(d)
    r = {"tekst": kort_tekst(d["name"], 24), "pictogram": PICTO.get(d.get("class"), "ster")}
    if "onoff" in c and d.get("class") not in BEVEILIGING:     # naast een schakelaar is plek voor 10 tekens
        r.update(tekst=kort_tekst(d["name"], 10), aan=bool(c["onoff"]), actie=f"s-{kort_id(d)}")
    elif c.get("measure_temperature") is not None: r["waarde"] = f"{c['measure_temperature']:.1f}°".replace(".", ",")
    elif "locked" in c: r["waarde"] = "op slot" if c["locked"] else "open"
    elif "garagedoor_closed" in c: r["waarde"] = "dicht" if c["garagedoor_closed"] else "open"
    elif c.get("alarm_contact") is not None: r["waarde"] = "open" if c["alarm_contact"] else "dicht"
    return r

def blok(ctx, bid):
    """Het scherm op Bolle. Tot vier schermen:
      vraag    als een garagedeur open staat: "Garage staat open. Dicht doen?" (alleen als je stilstaat, zoals de tool)
      lijst    je favoriete apparaten uit de Homey-app (zonder favorieten: lampen en stekkers), aan/uit met een schakelaar
      knoppen  je favoriete flows (twee tot vier), anders je sferen (als het er twee tot vier zijn); een tik start hem
      waarde   de temperatuur in huis (of hoeveel lampen er aan zijn); die staat ook op het beginscherm
    De regels leest de assistent voor; een oudere Bolle (BolleOS 1.1) toont titel, waarde en regels.
    Gaat er een alarm af (rook, brand, koolmonoxide, hitte, water), dan ook een melding uit zichzelf."""
    try: devs = lees(ctx, 30)
    except NietGekoppeld:
        return {"titel": "Huis", "waarde": "", "regels": ["Nog niet gekoppeld", "Koppel eerst: Menu > Apps"],
                "soort": "kaarten", "kaarten": [{"titel": "Nog niet gekoppeld", "tekst": "Koppel eerst: Menu > Apps > Homey"}]}
    aan = [d for d in devs if d.get("class") == "light" and caps(d).get("onoff")]
    thermo = next((d for d in devs if d.get("class") == "thermostat" and caps(d).get("measure_temperature") is not None), None)
    temp = caps(thermo)["measure_temperature"] if thermo else None
    doel = caps(thermo).get("target_temperature") if thermo else None
    al = alarmen(devs)
    open_ = [d for d in devs if caps(d).get("garagedoor_closed") is False]
    regels = [f"{d['name']}: alarm" for _, _, d in al][:2]
    regels += [f"{d['name']}: niet op slot" for d in devs if caps(d).get("locked") is False]
    regels += [f"{d['name']}: open" for d in open_]
    regels.append(f"{len(aan)} {'lamp' if len(aan) == 1 else 'lampen'} aan" if aan else "Alle lampen uit")
    if doel is not None: regels.append(f"Verwarming op {doel:g}°".replace(".", ","))
    if temp is not None: waarde = f"{temp:.1f}°".replace(".", ",")
    elif aan: waarde = f"{len(aan)} {'lamp' if len(aan) == 1 else 'lampen'}"
    else: waarde = ""
    naam = sessies.get(ctx.get("installatie"), (0, 0, "Huis"))[2]
    uit = {"titel": naam[:16], "waarde": waarde, "regels": regels[:6], "blok": "huis"}

    try: fav_d, fav_f = favorieten(ctx)
    except Exception: fav_d, fav_f = [], []
    per_id = {d.get("id"): d for d in devs}
    gekozen = [per_id[i] for i in fav_d if i in per_id] or \
              sorted((d for d in devs if d.get("class") in ("light", "socket") and "onoff" in caps(d)), key=lambda d: (d["_kamer"], d["name"]))
    schermen = []
    if open_:
        g = open_[0]
        schermen.append({"soort": "vraag", "titel": "Garage", "vraag": {"tekst": kort_tekst(f"{g['name']} staat open. Dicht doen?", 60),
                         "uitleg": kort_tekst(g["_kamer"] or "Garagedeur", 60), "ja": "Dicht", "nee": "Laat", "actie": f"g-{kort_id(g)}"}})
    if gekozen: schermen.append({"soort": "lijst", "titel": "Thuis", "rijen": [rij(d) for d in gekozen[:6]]})
    if fav_f:
        try: fl = {f["id"]: (f, soort) for f, soort in flows_kort(ctx)}
        except Exception: fl = {}
        kn = [{"tekst": kort_tekst(fl[i][0]["name"], 10), "pictogram": "ster", "actie": f"f-{kort_id(fl[i][0])}"} for i in fav_f if i in fl][:4]
        if len(kn) >= 2: schermen.append({"soort": "knoppen", "titel": "Flows", "knoppen": kn})
    if not any(x["soort"] == "knoppen" for x in schermen):         # geen favoriete flows: de sferen (twee tot vier)
        try: ms = moods_kort(ctx)
        except Exception: ms = []
        if 2 <= len(ms) <= 4:
            schermen.append({"soort": "knoppen", "titel": "Sferen", "knoppen":
                             [{"tekst": kort_tekst(m["name"], 10), "pictogram": "lamp", "actie": f"m-{kort_id(m)}"} for m in ms]})
    if waarde: schermen.append({"soort": "waarde", "titel": naam[:16], "waarde": waarde,
                                "regel": regels[-1] if regels and len(regels[-1]) <= 24 else ""})
    if schermen: uit["schermen"] = schermen[:4]
    if al:
        cap, titel, d = al[0]
        uit["melding"] = {"id": f"{cap}-{d.get('id') or d['name']}"[:64], "titel": titel, "icoon": "warn", "kleur": "gevaar", "geluid": "SFX_MSG"}
    return uit

def actie(ctx, a):
    """Een tik op Bolle (nooit tijdens het rijden: dat weigert de broker al). Alleen wat de tools ook doen:
      s-<id> aan/uit  een lamp of stekker aan of uit (zoals bedien)
      g-<id> ja/nee   de garagedeur dicht (zoals beveiliging; de vraag op het scherm is de bevestiging)
      f-<id> tik      een flow starten (zoals flow_starten)
      m-<id> tik      een sfeer aanzetten (zoals sfeer)
    Geeft wat Bolle groot laat zien (hooguit 40 tekens)."""
    soort, _, kid = (a.get("actie") or "").partition("-")
    antw = a.get("antwoord")
    if soort == "m":
        m = next((m for m in (homey(ctx, "/moods/mood") or {}).values() if kort_id(m) == kid), None)
        if not m: return "Die sfeer vind ik niet meer"
        homey(ctx, f"/moods/mood/{m['id']}/set", "POST", {})
        return kort_tekst(f"Sfeer {m['name']} aan", 40)
    if soort == "f":
        f = next(((f, s) for f, s in flows(ctx) if kort_id(f) == kid), None)
        if not f: return "Die flow vind ik niet meer"
        homey(ctx, f"/flow/{f[1]}/{f[0]['id']}/trigger", "POST", {})
        return kort_tekst(f"{f[0]['name']} gestart", 40)
    d = next((d for d in lees(ctx) if kort_id(d) == kid), None)
    if not d: return "Dat apparaat vind ik niet meer"
    if soort == "s" and antw in ("aan", "uit") and "onoff" in caps(d) and d.get("class") not in BEVEILIGING:
        homey(ctx, f"/devices/device/{d['id']}/capability/onoff", "PUT", {"value": antw == "aan"})
        _lees_cache.pop(ctx.get("installatie"), None)
        return kort_tekst(f"{d['name']} {antw}", 40)
    if soort == "g" and "garagedoor_closed" in caps(d):
        if antw != "ja": return kort_tekst(f"{d['name']} blijft open", 40)
        homey(ctx, f"/devices/device/{d['id']}/capability/garagedoor_closed", "PUT", {"value": True})
        _lees_cache.pop(ctx.get("installatie"), None)
        return kort_tekst(f"{d['name']} gaat dicht", 40)
    return "Dat kan hier niet"

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        self.send(200, {"ok": True}) if self.path == "/gezond" else self.send(404, {})
    def do_POST(self):
        rq = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        ctx = rq.get("context") or {}
        if self.path.startswith("/blok/"):
            try: return self.send(200, blok(ctx, self.path[6:]))
            except Exception as e: return self.send(200, {"titel": "Huis", "waarde": "", "regels": ["Homey nu niet bereikbaar", f"({type(e).__name__})"],
                                                          "soort": "kaarten", "kaarten": [{"titel": "Homey nu niet bereikbaar", "tekst": type(e).__name__}]})
        if self.path == "/actie":
            try: tekst = actie(ctx, {k: str(rq.get(k) or "") for k in ("blok", "actie", "antwoord")})
            except NietGekoppeld: tekst = "Homey is nog niet gekoppeld"
            except Exception: tekst = "De Homey weigerde het"
            return self.send(200, {"tekst": tekst})
        if self.path != "/mcp": return self.send(404, {})
        rid, p = rq.get("id"), rq.get("params") or {}
        if rq.get("method") == "tools/list":
            return self.send(200, {"jsonrpc": "2.0", "id": rid, "result": {"tools": [{"name": n} for n in TOOLS]}})
        if rq.get("method") == "tools/call" and p.get("name") in TOOLS:
            try: tekst, fout = TOOLS[p["name"]](ctx, p.get("arguments") or {}), False
            except NietGekoppeld: tekst, fout = KOPPELEN, False
            except Exception as e: tekst, fout = f"De Homey is nu niet bereikbaar ({type(e).__name__}).", True
            return self.send(200, {"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": tekst}], "isError": fout}})
        self.send(200, {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "onbekend"}})

if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("POORT") or 8080)), H).serve_forever()
