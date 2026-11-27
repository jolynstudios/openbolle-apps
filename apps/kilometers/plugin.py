"""App Kilometers (protocol 1.0 van het platform): zakelijke en privéritten bijhouden met je stem.

Geen internet. Alles staat in de opslag van de broker, per installatie, onder één sleutel ("ritten"):
  {"v": 1,
   "loopt":   {"t": <epoch s>, "s": "z"|"p", "b": <beginstand>, "d": "<doel>"}        (alleen als er een rit loopt)
   "ritten":  [["2026-11-24", "z"|"p", <begin of null>, <eind of null>, <km>, "<doel>"], ...]   (oudste eerst)
   "maanden": {"2026-11": [<km zakelijk>, <km privé>, <ritten zakelijk>, <ritten privé>], ...}}
De totalen per maand tellen apart mee, zodat ze kloppen ook als de oudste ritten wegvallen. Grenzen: hooguit
MAX_RITTEN ritten en MAX_MAANDEN maanden, en het geheel blijft onder MAX_BYTES (runtime.opslag_kb is 16).
De klok is die van Nederland (Europe/Amsterdam).

  broker  GET/PUT /plugin/v1/opslag/ritten     (recht opslag:klein, met het aanroep_token uit de context)

POST /mcp               tools/list | tools/call
POST /blok/kilometers   tegel
GET  /gezond
"""
import calendar, json, os, re, threading, time, urllib.error, urllib.request
from datetime import date, datetime, timedelta, timezone
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

BROKER = os.environ.get("BROKER_URL", "http://plugins:8000")
SLEUTEL = "ritten"
MAX_RITTEN, MAX_MAANDEN, MAX_BYTES = 100, 25, 14 * 1024
MAX_STAND, MAX_RIT_KM = 2_000_000, 2000
MAANDEN = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober",
           "november", "december"]
SOORT = {"z": "zakelijk", "p": "privé"}
_slot = threading.Lock()          # lezen-aanpassen-schrijven van de opslag na elkaar

class Ongeldig(Exception): pass    # de tekst gaat zo naar de gebruiker
class BrokerFout(Exception): pass

# ---------------------------------------------------------------- tijd (Europe/Amsterdam, zonder tzdata)

def _laatste_zondag(jaar, maand):
    d = date(jaar, maand, calendar.monthrange(jaar, maand)[1])
    return d - timedelta(days=(d.weekday() + 1) % 7)

def ams(t=None):
    """Tijd in Nederland: CET, en CEST van de laatste zondag van maart tot de laatste van oktober (01:00 UTC)."""
    u = datetime.fromtimestamp(time.time() if t is None else t, timezone.utc)
    zomer_in = datetime.combine(_laatste_zondag(u.year, 3), datetime.min.time(), timezone.utc) + timedelta(hours=1)
    zomer_uit = datetime.combine(_laatste_zondag(u.year, 10), datetime.min.time(), timezone.utc) + timedelta(hours=1)
    return (u + timedelta(hours=2 if zomer_in <= u < zomer_uit else 1)).replace(tzinfo=None)

def wanneer(t):
    """'08:12' vandaag, anders '23 nov 08:12'."""
    d, nu = ams(t), ams()
    return d.strftime("%H:%M") if d.date() == nu.date() else f"{d.day} {MAANDEN[d.month - 1][:3]} {d.strftime('%H:%M')}"

def maand_van(d): return f"{d.year:04d}-{d.month:02d}"

# ---------------------------------------------------------------- opslag bij de broker

def _broker(ctx, methode, body=None):
    r = urllib.request.Request(f"{BROKER}/plugin/v1/opslag/{SLEUTEL}", data=body, method=methode,
                               headers={"Authorization": "Bearer " + str(ctx.get("aanroep_token") or ""),
                                        **({"Content-Type": "application/octet-stream"} if body is not None else {})})
    try:
        with urllib.request.urlopen(r, timeout=2) as x: return x.read()
    except urllib.error.HTTPError as e:
        if e.code == 404 and methode == "GET": return None
        raise BrokerFout(e.code)
    except OSError as e:
        raise BrokerFout(type(e).__name__)

def lees(ctx):
    b = _broker(ctx, "GET")
    try: d = json.loads(b) if b else {}
    except ValueError: d = {}
    if not isinstance(d, dict): d = {}
    d.setdefault("v", 1); d.setdefault("ritten", []); d.setdefault("maanden", {})
    return d

def bewaar(ctx, d):
    for m in sorted(d["maanden"])[:-MAX_MAANDEN]: del d["maanden"][m]
    del d["ritten"][:-MAX_RITTEN]
    b = json.dumps(d, ensure_ascii=False, separators=(",", ":")).encode()
    while len(b) > MAX_BYTES and d["ritten"]:              # nooit boven runtime.opslag_kb: oudste ritten eerst weg
        d["ritten"].pop(0)
        b = json.dumps(d, ensure_ascii=False, separators=(",", ":")).encode()
    _broker(ctx, "PUT", b)

def tel(d, maand, s, km, keer=1):
    t = d["maanden"].setdefault(maand, [0, 0, 0, 0])
    i = 0 if s == "z" else 1
    t[i] = round(max(0, t[i] + keer * km), 1); t[i + 2] = max(0, t[i + 2] + keer)

# ---------------------------------------------------------------- invoer

def soort(x):
    s = str(x or "").strip().lower()
    if s.startswith("zak") or s in ("werk", "woon-werk", "woonwerk"): return "z"
    if s.startswith("priv"): return "p"
    raise Ongeldig("Is het een zakelijke of een privérit?")

def stand(x, wat):
    if x is None or x == "": return None
    try: n = round(x) if isinstance(x, (int, float)) and not isinstance(x, bool) else int(re.sub(r"[ .,]", "", str(x)))   # ook "45.230"
    except ValueError: raise Ongeldig(f"Ik verstond de {wat} niet. Noem hem in hele kilometers.")
    if not 0 <= n <= MAX_STAND: raise Ongeldig(f"Een {wat} van {n} km kan niet. Noem hem nog eens.")
    return n

def afstand(x):
    if x is None or x == "": return None
    try: km = round(float(str(x).replace(",", ".")), 1)
    except ValueError: raise Ongeldig("Ik verstond de afstand niet. Hoeveel kilometer was de rit?")
    if not 0 < km <= MAX_RIT_KM: raise Ongeldig(f"Een rit van {km:g} km kan ik niet noteren (tussen 0 en {MAX_RIT_KM} km).")
    return km

def tekstje(x):
    return re.sub(r"[\x00-\x1f]", "", str(x or "")).strip()[:40]

def laatste_stand(d):
    st = [r[3] for r in d["ritten"] if r[3] is not None]
    return max(st) if st else None

def rit(s): return "zakelijke rit" if s == "z" else "privérit"

def km_tekst(km): return f"{km:g}".replace(".", ",") + " km"

def naar(doel): return f" ({doel})" if doel else ""

def check_teller(d, begin):
    """Een waarschuwing als de beginstand lager is dan de vorige eindstand (de teller loopt niet terug)."""
    vorige = laatste_stand(d)
    return f" Let op: dat is lager dan de vorige eindstand ({vorige}). Klopt dat niet, wis de rit dan." if vorige and begin < vorige else ""

def deze_maand(d):
    t = d["maanden"].get(maand_van(ams()), [0, 0, 0, 0])
    return f"Deze maand: {km_tekst(round(t[0]))} zakelijk, {km_tekst(round(t[1]))} privé."

def voeg_toe(d, s, begin, eind, km, doel, t=None):
    nu = ams(t)
    d["ritten"].append([nu.date().isoformat(), s, begin, eind, km, doel])
    tel(d, maand_van(nu), s, km)

# ---------------------------------------------------------------- tools

def rit_start(ctx, a):
    s, b, doel = soort(a.get("soort")), stand(a.get("beginstand"), "beginstand"), tekstje(a.get("doel"))
    if b is None: raise Ongeldig("Wat is de kilometerstand bij vertrek?")
    with _slot:
        d = lees(ctx)
        if d.get("loopt"):
            l = d["loopt"]
            raise Ongeldig(f"Er loopt al een {rit(l['s'])} sinds {wanneer(l['t'])}, begin {l['b']}. "
                           "Zeg eerst de eindstand van die rit, of laat hem wissen.")
        let_op = check_teller(d, b)
        d["loopt"] = {"t": int(time.time()), "s": s, "b": b, "d": doel}
        bewaar(ctx, d)
    return f"Genoteerd: {rit(s)}{naar(doel)}, begonnen om {ams().strftime('%H:%M')} bij {b} km.{let_op} Zeg bij aankomst de eindstand."

def rit_einde(ctx, a):
    e, doel = stand(a.get("eindstand"), "eindstand"), tekstje(a.get("doel"))
    if e is None: raise Ongeldig("Wat is de kilometerstand bij aankomst?")
    with _slot:
        d = lees(ctx)
        l = d.get("loopt")
        if not l: raise Ongeldig("Er loopt geen rit. Noem de hele rit, met de afstand of met begin- en eindstand.")
        if e < l["b"]: raise Ongeldig(f"De eindstand {e} is lager dan de beginstand {l['b']}. Noem de eindstand nog eens.")
        km = e - l["b"]
        if km > MAX_RIT_KM: raise Ongeldig(f"Dat zou een rit van {km} km zijn. Klopt de eindstand {e}? Noem hem nog eens.")
        doel = l.get("d") or doel
        voeg_toe(d, l["s"], l["b"], e, km, doel, l["t"])     # de rit telt in de maand waarin hij begon
        del d["loopt"]
        bewaar(ctx, d)
    return f"Rit afgesloten: {km_tekst(km)} {SOORT[l['s']]}{naar(doel)}, van {l['b']} tot {e}. {deze_maand(d)}"

def rit_noteer(ctx, a):
    s, doel = soort(a.get("soort")), tekstje(a.get("doel"))
    b, e = stand(a.get("beginstand"), "beginstand"), stand(a.get("eindstand"), "eindstand")
    if (b is None) != (e is None):
        if a.get("km") in (None, ""):
            raise Ongeldig("Ik heb de begin- en de eindstand nodig, of de afstand van de rit.")
        b = e = None                                        # alleen de afstand telt dan
    if b is not None:
        if e < b: raise Ongeldig(f"De eindstand {e} is lager dan de beginstand {b}. Noem ze nog eens.")
        km = e - b
        if not 0 < km <= MAX_RIT_KM: raise Ongeldig(f"Een rit van {km} km kan ik niet noteren. Kloppen de standen?")
    else:
        km = afstand(a.get("km"))
        if km is None: raise Ongeldig("Hoeveel kilometer was de rit? Of noem de begin- en eindstand.")
    with _slot:
        d = lees(ctx)
        let_op = check_teller(d, b) if b is not None else ""
        voeg_toe(d, s, b, e, km, doel)
        bewaar(ctx, d)
    van = f", van {b} tot {e}" if b is not None else ""
    return f"Genoteerd: {km_tekst(km)} {SOORT[s]}{naar(doel)}{van}.{let_op} {deze_maand(d)}"

def kilometers_overzicht(ctx, a):
    p = str(a.get("periode") or "deze_maand")
    nu = ams()
    with _slot: d = lees(ctx)
    if p == "dit_jaar":
        ms = [t for m, t in d["maanden"].items() if m.startswith(f"{nu.year:04d}-")]
        naam = f"Dit jaar ({nu.year})"
    else:
        j, m = (nu.year, nu.month) if p != "vorige_maand" else ((nu.year, nu.month - 1) if nu.month > 1 else (nu.year - 1, 12))
        ms = [d["maanden"].get(f"{j:04d}-{m:02d}", [0, 0, 0, 0])]
        naam = f"{'Deze' if p != 'vorige_maand' else 'Vorige'} maand ({MAANDEN[m - 1]})"
    z, pr, nz, np_ = (sum(t[i] for t in ms) for i in range(4))
    if not nz and not np_:
        tekst = f"{naam}: nog geen ritten genoteerd."
    else:
        tekst = (f"{naam}: zakelijk {km_tekst(round(z))} in {nz} {'rit' if nz == 1 else 'ritten'}, "
                 f"privé {km_tekst(round(pr))} in {np_} {'rit' if np_ == 1 else 'ritten'}.")
    if p == "dit_jaar" and pr:
        tekst += " Met een verklaring geen privégebruik mag je hooguit 500 km privé per jaar rijden."
    if d["ritten"]:
        r = d["ritten"][-1]
        dt = date.fromisoformat(r[0])
        tekst += f" Laatste rit: {dt.day} {MAANDEN[dt.month - 1]}, {km_tekst(r[4])} {SOORT[r[1]]}{naar(r[5])}."
    if d.get("loopt"):
        l = d["loopt"]
        tekst += f" Er loopt een {rit(l['s'])} sinds {wanneer(l['t'])}, begin {l['b']}."
    return tekst

def laatste_rit_wissen(ctx, a):
    with _slot:
        d = lees(ctx)
        if d.get("loopt"):
            l = d.pop("loopt")
            bewaar(ctx, d)
            return f"De lopende {rit(l['s'])} (sinds {wanneer(l['t'])}, begin {l['b']}) is gewist."
        if not d["ritten"]: raise Ongeldig("Er is geen rit om te wissen.")
        r = d["ritten"].pop()
        tel(d, r[0][:7], r[1], r[4], -1)
        bewaar(ctx, d)
    dt = date.fromisoformat(r[0])
    return f"Gewist: de rit van {dt.day} {MAANDEN[dt.month - 1]}, {km_tekst(r[4])} {SOORT[r[1]]}{naar(r[5])}. {deze_maand(d)}"

TOOLS = {"rit_start": rit_start, "rit_einde": rit_einde, "rit_noteer": rit_noteer,
         "kilometers_overzicht": kilometers_overzicht, "laatste_rit_wissen": laatste_rit_wissen}

def fouttekst(e):
    if isinstance(e, Ongeldig): return str(e)
    if isinstance(e, BrokerFout): return "Ik kan de ritten nu niet bewaren of lezen (geen verbinding met openBolle). Probeer het zo nog eens."
    return f"Dat lukt nu niet ({type(e).__name__})."

# ---------------------------------------------------------------- tegel

def km_punt(km): return f"{round(km):,}".replace(",", ".") + " km"   # 1.234 km

def blok_kilometers(ctx):
    """Het scherm op Bolle (BolleOS 1.2): een waarde-scherm, zoals de snelheid. Groot de zakelijke km van deze maand
    met "km" eronder en het aantal ritten. Op het beginscherm "Kilometers 1.412 km" (de waarde van het blok zelf).
    Nog geen ritten deze maand: een kaart met wat je kunt zeggen. De regels leest de assistent voor (lopende rit,
    privé, ritten, dit jaar); een oudere Bolle toont ze ook."""
    def kaart(titel, tekst=None):
        return {"soort": "kaarten", "kaarten": [{"titel": titel, **({"tekst": tekst} if tekst else {})}]}
    try: d = lees(ctx)
    except BrokerFout:
        return {"titel": "Kilometers", "waarde": "", "regels": ["Ritten nu niet te lezen", "Probeer het zo opnieuw"],
                **kaart("Ritten nu niet te lezen", "Probeer het zo opnieuw")}
    nu = ams()
    mnd = MAANDEN[nu.month - 1]
    t = d["maanden"].get(maand_van(nu), [0, 0, 0, 0])
    jaar = [x for m, x in d["maanden"].items() if m.startswith(f"{nu.year:04d}-")]
    jz, jp = sum(x[0] for x in jaar), sum(x[1] for x in jaar)
    l = d.get("loopt")
    loopt = f"{rit(l['s'])[0].upper()}{rit(l['s'])[1:]} sinds {wanneer(l['t'])}" if l else None
    regels = [loopt] if loopt else []
    n = t[2] + t[3]
    if not n:
        regels.append(f"Nog geen ritten in {mnd}")
        if jz or jp: regels += [f"Dit jaar {km_punt(jz)} zakelijk", f"Dit jaar {km_punt(jp)} privé"]
        if not d["ritten"] and not l: regels += ["Zeg: noteer een zakelijke rit,", "kilometerstand ..."]
        k = kaart(loopt or f"Nog geen ritten in {mnd}",
                  f"Dit jaar {km_punt(jz)} zakelijk, {km_punt(jp)} privé" if jz or jp
                  else None if l else "Zeg: noteer een zakelijke rit, kilometerstand ...")
        return {"titel": "Kilometers", "waarde": "", "regels": regels[:5], **k}
    regels += [f"Privé {km_punt(t[1])}", f"{n} {'rit' if n == 1 else 'ritten'} in {mnd}",
               f"Dit jaar {km_punt(jz)} zakelijk", f"Dit jaar {km_punt(jp)} privé"]
    titel = f"Zakelijk {mnd}" if len(f"Zakelijk {mnd}") <= 16 else f"Zakelijk {mnd[:3]}."
    # het scherm: het getal zonder "km" (dat staat er klein onder); het blok zelf houdt "1.412 km" voor het beginscherm
    scherm = {"soort": "waarde", "titel": titel, "waarde": km_punt(t[0])[:-3], "eenheid": "km",
              "regel": f"{n} {'rit' if n == 1 else 'ritten'}"}
    return {"titel": titel, "waarde": km_punt(t[0]), "regels": regels[:6], "blok": "kilometers", "schermen": [scherm]}

BLOKKEN = {"kilometers": blok_kilometers}

# ---------------------------------------------------------------- server

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass                      # geen ritten in de log
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
            except Exception as e: return self.stuur({"titel": "Kilometers", "waarde": "", "regels": [f"Nu niet op te halen ({type(e).__name__})."]})
        if self.path != "/mcp": return self.stuur({}, 404)
        rid, p = rq.get("id"), rq.get("params") or {}
        if rq.get("method") == "tools/list":
            return self.stuur({"jsonrpc": "2.0", "id": rid, "result": {"tools": [{"name": n} for n in TOOLS]}})
        if rq.get("method") == "tools/call" and p.get("name") in TOOLS:
            try: tekst, fout = TOOLS[p["name"]](rq.get("context") or {}, p.get("arguments") or {}), False
            except Exception as e: tekst, fout = fouttekst(e), True
            return self.stuur({"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": tekst}], "isError": fout}})
        self.stuur({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "onbekend"}})

if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("POORT") or 8080)), H).serve_forever()
