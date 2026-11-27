#!/usr/bin/env python3
"""Controleert alle apps (of de opgegeven mappen): schema, regels uit PLATFORM.md 7, en of de code past bij het manifest.

    python3 tools/controleer.py                 # alle apps (apps/*/, en het oude plugins/*/)
    python3 tools/controleer.py apps/reisgids
    python3 tools/controleer.py --contract apps/reisgids   # start de app ook en vergelijkt tools/list

Het manifest heet app.yaml; het oude plugin.yaml lezen we nog.

Nodig: pip install pyyaml jsonschema
"""
import ipaddress, json, os, re, subprocess, sys, time, urllib.request
import yaml, jsonschema

HIER = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = json.load(open(os.path.join(HIER, "schema", "app.schema.json")))
MANIFESTEN = ("app.yaml", "plugin.yaml")      # app.yaml is de nieuwe naam; plugin.yaml lezen we nog

def manifest_pad(map_):
    """Het manifest in map_: app.yaml, anders plugin.yaml (de oude naam); app.yaml als er geen is."""
    return next((os.path.join(map_, n) for n in MANIFESTEN if os.path.isfile(os.path.join(map_, n))), os.path.join(map_, MANIFESTEN[0]))

VERBODEN_WOORDEN = re.compile(r"(negeer|ignore|vergeet).{0,30}(instructie|instruction|regels|rules)|system prompt|systeemprompt", re.I)

def logo_fouten(pad):
    """PNG, vierkant, minstens 256 px, hooguit 100 KB (zonder Pillow: de maat staat in de IHDR-kop)."""
    if not os.path.isfile(pad): return ["bestand ontbreekt"]
    b = open(pad, "rb").read()
    if b[:8] != b"\x89PNG\r\n\x1a\n" or b[12:16] != b"IHDR": return ["geen PNG"]
    w, h = int.from_bytes(b[16:20], "big"), int.from_bytes(b[20:24], "big")
    f = []
    if w != h: f.append(f"niet vierkant ({w} × {h})")
    if min(w, h) < 256: f.append(f"te klein ({w} × {h}, minstens 256 × 256)")
    if len(b) > 100 * 1024: f.append(f"te groot ({len(b) // 1024} KB, hooguit 100 KB)")
    return f

def afbeelding_fouten(pad):
    """Scherm voor de winkel: PNG, hooguit 466 × 466, hooguit 200 KB."""
    if not os.path.isfile(pad): return ["bestand ontbreekt"]
    b = open(pad, "rb").read()
    if b[:8] != b"\x89PNG\r\n\x1a\n" or b[12:16] != b"IHDR": return ["geen PNG"]
    w, h = int.from_bytes(b[16:20], "big"), int.from_bytes(b[20:24], "big")
    f = []
    if w > 466 or h > 466: f.append(f"te groot ({w} × {h}, hooguit 466 × 466)")
    if len(b) > 200 * 1024: f.append(f"te groot ({len(b) // 1024} KB, hooguit 200 KB)")
    return f

def presentatie_fouten(pid, map_, pr):
    f = []
    for a in pr.get("afbeeldingen") or []: f += [f"{pid}: afbeelding {a['bestand']}: {x}" for x in afbeelding_fouten(os.path.join(map_, a["bestand"]))]
    d = pr.get("documentatie")
    if d and not os.path.isfile(os.path.join(map_, d)): f.append(f"{pid}: documentatie {d} ontbreekt")
    return f

def fouten_voor(map_):
    f = []
    pid = os.path.basename(os.path.normpath(map_))
    pad = manifest_pad(map_)
    if not os.path.isfile(pad): return [f"{pid}: app.yaml ontbreekt"]
    try: m = yaml.safe_load(open(pad))
    except Exception as e: return [f"{pid}: {os.path.basename(pad)} is geen geldige YAML: {e}"]
    for e in sorted(jsonschema.Draft202012Validator(SCHEMA).iter_errors(m), key=lambda e: list(e.path)):
        f.append(f"{pid}: {'/'.join(map(str, e.path)) or '(manifest)'}: {e.message}")
    if f: return f
    if m["id"] != pid: f.append(f"{pid}: id '{m['id']}' moet gelijk zijn aan de mapnaam")
    if not os.path.isfile(os.path.join(map_, "Dockerfile")): f.append(f"{pid}: Dockerfile ontbreekt")
    if m.get("logo"): f += [f"{pid}: logo {m['logo']}: {x}" for x in logo_fouten(os.path.join(map_, m["logo"]))]
    if m.get("presentatie"): f += presentatie_fouten(pid, map_, m["presentatie"])
    r = set(m["rechten"])
    for t in m.get("tools") or []:
        if len(f"{pid}__{t['naam']}") > 64: f.append(f"{pid}: toolnaam {t['naam']} te lang (met app-id max 64)")
        if VERBODEN_WOORDEN.search(t["beschrijving"]): f.append(f"{pid}: beschrijving van {t['naam']} lijkt instructies aan het taalmodel te bevatten")
    if (m.get("tools")) and "spraak:tools" not in r: f.append(f"{pid}: tools zonder recht spraak:tools")
    if (m.get("blokken")) and "blokken:tonen" not in r: f.append(f"{pid}: blokken zonder recht blokken:tonen")
    if (m.get("taken")) and "achtergrond:taken" not in r: f.append(f"{pid}: taken zonder recht achtergrond:taken")
    hosts = (m.get("netwerk") or {}).get("uitgaand") or []
    if hosts and "netwerk:uitgaand" not in r: f.append(f"{pid}: netwerk.uitgaand zonder recht netwerk:uitgaand")
    if "netwerk:uitgaand" in r and not hosts: f.append(f"{pid}: recht netwerk:uitgaand zonder hosts")
    for h in hosts:
        naam, _, poort = h.rpartition(":")
        if poort != "443": f.append(f"{pid}: {h}: alleen poort 443")
        try: ipaddress.ip_address(naam.strip("[]")); f.append(f"{pid}: {h}: geen IP-adressen, alleen namen")
        except ValueError: pass
        if "*" in naam[1:] or (naam.startswith("*") and not naam.startswith("*.")): f.append(f"{pid}: {h}: * alleen als eerste label")
        if re.search(r"(^|\.)(openbolle\.nl|redlinewars\.online|localhost|internal|local)$", naam): f.append(f"{pid}: {h}: verboden host")
    for t in m.get("tools") or []:
        if re.search(r"slot|alarm|garage|betaal|deur_open", t["naam"]) and not t.get("bevestigen"):
            f.append(f"{pid}: {t['naam']} lijkt een handeling met gevolgen: zet bevestigen: true")
    return f

def contract(map_):
    """Bouwt de app, start hem en vergelijkt tools/list met het manifest."""
    pid = os.path.basename(os.path.normpath(map_))
    m = yaml.safe_load(open(manifest_pad(map_)))
    img = f"openbolle-test/{pid}"
    subprocess.run(["docker", "build", "-q", "-t", img, map_], check=True, stdout=subprocess.DEVNULL)
    cid = subprocess.run(["docker", "run", "-d", "--rm", "-p", "127.0.0.1::8080", "--read-only", "--tmpfs", "/tmp",
                          "--cap-drop", "ALL", "--user", "65532:65532", img], check=True, capture_output=True, text=True).stdout.strip()
    try:
        poort = subprocess.run(["docker", "port", cid, "8080"], capture_output=True, text=True).stdout.strip().rsplit(":", 1)[1]
        for _ in range(30):
            try: urllib.request.urlopen(f"http://127.0.0.1:{poort}/gezond", timeout=1); break
            except Exception: time.sleep(0.5)
        else: return [f"{pid}: /gezond antwoordt niet"]
        rq = urllib.request.Request(f"http://127.0.0.1:{poort}/mcp", data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).encode(),
                                    headers={"Content-Type": "application/json"})
        namen = sorted(t["name"] for t in json.load(urllib.request.urlopen(rq, timeout=5))["result"]["tools"])
        verwacht = sorted(t["naam"] for t in m.get("tools") or [])
        f = [] if namen == verwacht else [f"{pid}: tools/list {namen} is niet gelijk aan het manifest {verwacht}"]
        for b in m.get("blokken") or []:          # elk blok moet antwoorden met titel/waarde/regels (ook zonder plek)
            rq = urllib.request.Request(f"http://127.0.0.1:{poort}/blok/{b['id']}", headers={"Content-Type": "application/json"},
                                        data=json.dumps({"context": {"installatie": "ins_test", "instellingen": {}, "aanroep_token": "x"}}).encode())
            try:
                j = json.load(urllib.request.urlopen(rq, timeout=5))
                if not isinstance(j, dict) or not isinstance(j.get("regels", []), list): f.append(f"{pid}: blok {b['id']} geeft geen geldig blok")
            except Exception as e: f.append(f"{pid}: blok {b['id']}: {e}")
        return f
    finally:
        subprocess.run(["docker", "rm", "-f", cid], capture_output=True)

if __name__ == "__main__":
    args = sys.argv[1:]
    doe_contract = "--contract" in args
    args = [a for a in args if a != "--contract"]
    mappen = args or [os.path.join(HIER, a, d) for a in ("apps", "plugins") if os.path.isdir(os.path.join(HIER, a))
                      for d in sorted(os.listdir(os.path.join(HIER, a))) if os.path.isdir(os.path.join(HIER, a, d))]
    alle = []
    for d in mappen:
        f = fouten_voor(d)
        if not f and doe_contract: f = contract(d)
        print(("FOUT  " if f else "goed  ") + os.path.basename(os.path.normpath(d)))
        alle += f
    for x in alle: print("  - " + x)
    sys.exit(1 if alle else 0)
