#!/usr/bin/env python3
"""Lokaal een app proberen zonder het platform: speelt de broker na.

    python3 apps/reisgids/plugin.py &                  # of: docker run -p 8080:8080 ...
    python3 tools/testbroker.py apps/reisgids vertel_over '{"onderwerp": "Dom van Utrecht"}'

De testbroker zet de omhulling (context) zoals de echte broker dat doet, en beantwoordt de terugroep-API zelf:
opslag in het geheugen, en /plugin/v1/data/* met voorbeelddata uit tools/voorbeelddata.json.
"""
import argparse, json, os, secrets, threading, urllib.request
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import yaml

HIER = os.path.dirname(os.path.abspath(__file__))
opslag, TOKEN = {}, secrets.token_urlsafe(16)

class Terug(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def ok(self, code, b, t="application/json"):
        self.send_response(code); self.send_header("Content-Type", t); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def toegang(self):
        if self.headers.get("Authorization") != "Bearer " + TOKEN: self.ok(401, b'{"fout":"token"}'); return False
        return True
    def do_GET(self):
        if not self.toegang(): return
        if self.path.startswith("/plugin/v1/opslag/"):
            v = opslag.get(self.path.rsplit("/", 1)[1]); return self.ok(200, v, "application/octet-stream") if v is not None else self.ok(404, b"{}")
        if self.path.startswith("/plugin/v1/data/"):
            vb = json.load(open(os.path.join(HIER, "voorbeelddata.json")))
            sleutel = "laadpaal" if self.path.startswith("/plugin/v1/data/laadpaal/") else self.path.split("?")[0].rsplit("/", 1)[1]
            return self.ok(200, json.dumps(vb.get(sleutel, {})).encode()) if sleutel in vb else self.ok(404, b"{}")
        self.ok(404, b"{}")
    def do_PUT(self):
        if not self.toegang(): return
        opslag[self.path.rsplit("/", 1)[1]] = self.rfile.read(int(self.headers.get("Content-Length") or 0)); self.ok(204, b"")
    def do_DELETE(self):
        if not self.toegang(): return
        opslag.pop(self.path.rsplit("/", 1)[1], None); self.ok(204, b"")

if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("map"); a.add_argument("tool"); a.add_argument("args", nargs="?", default="{}")
    a.add_argument("--plek", help="lat,lon"); a.add_argument("--rijdt", action="store_true")
    a.add_argument("--app", "--plugin", dest="app", default="http://127.0.0.1:8080"); a.add_argument("--poort", type=int, default=8000)
    o = a.parse_args()
    pad = next((os.path.join(o.map, n) for n in ("app.yaml", "plugin.yaml") if os.path.isfile(os.path.join(o.map, n))), os.path.join(o.map, "app.yaml"))
    m = yaml.safe_load(open(pad))
    srv = ThreadingHTTPServer(("127.0.0.1", o.poort), Terug); threading.Thread(target=srv.serve_forever, daemon=True).start()
    inst = {i["sleutel"]: i["standaard"] for i in m.get("instellingen") or [] if "standaard" in i}
    ctx = {"installatie": "ins_test", "taal": "nl", "instellingen": inst, "aanroep_token": TOKEN, "verzoek_id": "test"}
    if o.plek and any(r.startswith("locatie:") for r in m["rechten"]):
        lat, lon = map(float, o.plek.split(",")); n = 3 if "locatie:precies" in m["rechten"] else 2
        ctx["locatie"] = {"lat": round(lat, n), "lon": round(lon, n)}
    if "rit:status" in m["rechten"]: ctx["rijdt"] = o.rijdt
    rq = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": o.tool, "arguments": json.loads(o.args)}, "context": ctx}
    r = urllib.request.Request(o.app + "/mcp", data=json.dumps(rq).encode(), headers={"Content-Type": "application/json"})
    print(json.dumps(json.load(urllib.request.urlopen(r, timeout=10)), indent=2, ensure_ascii=False))
