#!/usr/bin/env python3
"""Maakt winkel.json: de index van een winkel, voor Bolle en de website.

  python3 tools/maak_winkel.py [map]          (standaard: de map van deze repo)

Leest winkel.yaml (naam, beschrijving, website, en voor accessoireprofielen: sleutel = pad naar de publieke
sleutel) en het manifest van elke app (app.yaml, of het oude plugin.yaml): in apps/*/ (of het oude plugins/*/), of in
de map zelf (een winkel met één app). Paden in winkel.json zijn relatief aan winkel.json, zodat de winkel overal kan staan
(GitHub, een eigen server). De sleutel "plugins" in winkel.json blijft zo heten: zo leest BolleOS hem.
Zie schema/winkel.schema.json."""
import json, os, sys, glob
import yaml

MANIFESTEN = ("app.yaml", "plugin.yaml")      # app.yaml is de nieuwe naam; plugin.yaml lezen we nog

def manifest_in(d):
    """Het pad van het manifest in map d (app.yaml, anders plugin.yaml), of None."""
    return next((os.path.join(d, n) for n in MANIFESTEN if os.path.isfile(os.path.join(d, n))), None)

def main():
    root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), ".."))
    meta = yaml.safe_load(open(os.path.join(root, "winkel.yaml"))) if os.path.exists(os.path.join(root, "winkel.yaml")) else {}
    w = {"winkel": 1, "naam": meta.get("naam", os.path.basename(root))}
    for k in ("beschrijving", "website"):
        if meta.get(k): w[k] = meta[k].strip()
    if meta.get("sleutel"): w["sleutel"] = open(os.path.join(root, meta["sleutel"])).read()
    w["plugins"] = []
    mappen = [m for a in ("apps", "plugins") for m in sorted(filter(None, map(manifest_in, glob.glob(os.path.join(root, a, "*")))))]
    for py in mappen or [manifest_in(root)]:
        if not py: continue
        m = yaml.safe_load(open(py)); d = os.path.dirname(py)
        rel = lambda f: os.path.relpath(os.path.join(d, f), root).replace(os.sep, "/")
        b = m.get("beschrijving") or {}
        pr = m.get("presentatie") or {}
        e = {"id": m["id"], "naam": m["naam"], "versie": str(m["versie"]), "soort": m.get("soort", "server"),
             "kort": b.get("kort", "") if isinstance(b, dict) else str(b)}
        if isinstance(b, dict) and b.get("lang"): e["lang"] = b["lang"].strip()
        if m.get("categorie"): e["categorie"] = m["categorie"]
        if isinstance(m.get("auteur"), dict) and m["auteur"].get("naam"): e["auteur"] = m["auteur"]["naam"]
        if m.get("logo"): e["logo"] = rel(m["logo"])
        if pr.get("afbeeldingen"): e["afbeeldingen"] = [{"bestand": rel(a["bestand"]), "uitleg": a["uitleg"]} for a in pr["afbeeldingen"]]
        if pr.get("documentatie"): e["documentatie"] = rel(pr["documentatie"])
        if pr.get("website"): e["website"] = pr["website"]
        if m.get("voorbeelden"): e["voorbeelden"] = m["voorbeelden"]
        if meta.get("bron"): e["bron"] = meta["bron"].rstrip("/") + "/" + os.path.relpath(d, root).replace(os.sep, "/")
        if e["soort"] == "accessoire":
            e["profiel"] = rel(m["profiel"]); e["handtekening"] = rel(m["handtekening"])
        for f in [e.get("logo"), e.get("documentatie"), e.get("profiel"), e.get("handtekening")] + [a["bestand"] for a in e.get("afbeeldingen", [])]:
            if f and not os.path.exists(os.path.join(root, f)): sys.exit(f"{m['id']}: bestand ontbreekt: {f}")
        w["plugins"].append(e)
    out = os.path.join(root, "winkel.json")
    open(out, "w").write(json.dumps(w, ensure_ascii=False, indent=1) + "\n")
    print(f"{out}: {len(w['plugins'])} app(s)")

if __name__ == "__main__":
    main()
