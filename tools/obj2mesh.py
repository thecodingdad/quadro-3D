#!/usr/bin/env python3
"""Wandelt die aus `Quadro.exe` abgegriffenen OBJ-Modelle in die schlanken
JSON-Dateien um, die der Editor lädt.

Kein Build-Step für die App: das Skript läuft nur von Hand, wenn sich die
Modelle ändern sollen. Das Ergebnis liegt im Repo und wird ausgeliefert.

    python3 tools/obj2mesh.py [quelle]

Quelle ist der Ordner mit den OBJs (voreingestellt `tmp/extracted/models`, wo
der Mitschnitt sie ablegt -- der Ordner selbst gehört nicht ins Repo). Erzeugt
werden `data/models/connectors.json` und `data/models/slides.json`.

Format je Modell -- ganze Zahlen, damit die Datei kurz bleibt:

    { "mask": 3, "pos": [...], "nrm": [...], "idx": [...] }

`pos` in 0,1 mm (durch 100 ergibt Zentimeter, die Einheit des Editors),
`nrm` in 1/1000, `idx` sind Dreiecks-Indizes. Gleiche Ecken werden dabei
verschweißt: gezählt wird nach Position UND Normale, sonst verschliffe das
Verschweißen die harten Kanten.
"""

import json
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SOURCE = os.path.join(ROOT, "tmp", "extracted", "models")
TARGET = os.path.join(ROOT, "data", "models")

# Kupplungen: Katalog-Kennung -> (Datei, Arm-Maske). Die Maske sagt, welche der
# sechs Würfelflächen einen Arm trägt (0x01 +X, 0x02 -X, 0x04 +Y, 0x08 -Y,
# 0x10 +Z, 0x20 -Z) -- dieselbe Bitfolge wie `variant2` in der QDF-Datei.
# Genommen wird jeweils die Fassung MIT Armen; das echte Teil hat sie, die
# Herstellersoftware zeichnet sie nur nicht, weil sie im Rohr stecken.
CONNECTORS = {
    "straight": ("connectors/connector3_straight_mask3_stubs.obj", 3),
    "elbow":    ("connectors/connector3_elbow_mask5_stubs.obj", 5),
    "t":        ("connectors/connector3_t_mask7_stubs.obj", 7),
    "cross":    ("connectors/connector3_cross_mask15_stubs.obj", 15),
    "4way":     ("connectors/connector3_4way_mask23_stubs.obj", 23),
    "5way":     ("connectors/connector3_5way_mask31_stubs.obj", 31),
    "6way":     ("connectors/connector3_6way_mask63_stubs.obj", 63),
}

# NICHT dabei: `connector3_3way_mask13_stubs.obj`. Die Maske 13 ist
# 0x01|0x04|0x08 = +X, +Y, -Y -- zwei gegenueberliegende Arme plus einer quer,
# also ein T in EINER Ebene und damit dieselbe Form wie Maske 7. Die
# Raumkupplung 3-armig braucht drei zueinander SENKRECHTE Arme (z. B. Maske 21
# = +X, +Y, +Z); dafuer liegt kein Mitschnitt vor. Solche Knoten bekommen
# weiter den selbst gezeichneten Wuerfel (siehe maskTable in scene.js).

# Rutschen und Dächer, benannt nach ihrer QDF-Elementart.
SLIDES = {
    "slide2": "slide2.obj",
    "slide-new2": "slide-new2.obj",
    "curved-slide2": "curved-slide2.obj",
    "slide-end2": "slide-end2.obj",
    "roof2": "roof2.obj",
    "roof-large2": "roof-large2.obj",
}

POS_SCALE = 10      # mm -> 0,1 mm
NRM_SCALE = 1000


def read_obj(path):
    """OBJ einlesen: Ecken, Normalen und Dreiecke (Vielecke werden gefächert)."""
    verts, norms, tris = [], [], []
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            if line.startswith("v "):
                verts.append([float(x) for x in line.split()[1:4]])
            elif line.startswith("vn "):
                norms.append([float(x) for x in line.split()[1:4]])
            elif line.startswith("f "):
                corners = [c.split("/") for c in line.split()[1:]]
                for k in range(1, len(corners) - 1):
                    tris.append([corners[0], corners[k], corners[k + 1]])
    return verts, norms, tris


def face_normals(verts, tris):
    """Ersatz-Normalen für Dateien ohne `vn`: je Ecke der flächengewichtete
    Mittelwert der angrenzenden Dreiecke. Das ist die übliche Glättung -- die
    einzige betroffene Datei ist die Integralrutsche aus dem VRML-Export."""
    acc = [[0.0, 0.0, 0.0] for _ in verts]
    for tri in tris:
        a, b, c = (verts[int(t[0]) - 1] for t in tri)
        u = [b[i] - a[i] for i in range(3)]
        v = [c[i] - a[i] for i in range(3)]
        n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
        for t in tri:
            for i in range(3):
                acc[int(t[0]) - 1][i] += n[i]
    out = []
    for n in acc:
        length = math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2) or 1.0
        out.append([n[0] / length, n[1] / length, n[2] / length])
    return out


def convert(path):
    verts, norms, tris = read_obj(path)
    fallback = face_normals(verts, tris) if not norms else None

    seen, pos, nrm, idx = {}, [], [], []
    for tri in tris:
        for corner in tri:
            vi = int(corner[0]) - 1
            v = verts[vi]
            if norms and len(corner) > 2 and corner[2]:
                n = norms[int(corner[2]) - 1]
            else:
                n = fallback[vi] if fallback else [0.0, 0.0, 0.0]
            key = (round(v[0], 2), round(v[1], 2), round(v[2], 2),
                   round(n[0], 3), round(n[1], 3), round(n[2], 3))
            at = seen.get(key)
            if at is None:
                at = seen[key] = len(pos) // 3
                pos += [int(round(v[i] * POS_SCALE)) for i in range(3)]
                nrm += [int(round(n[i] * NRM_SCALE)) for i in range(3)]
            idx.append(at)
    if len(pos) // 3 > 65535:
        raise SystemExit("%s: mehr als 65535 Ecken -- Uint16-Indizes reichen nicht" % path)
    return {"pos": pos, "nrm": nrm, "idx": idx}


def write(name, data):
    os.makedirs(TARGET, exist_ok=True)
    path = os.path.join(TARGET, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
        f.write("\n")
    size = os.path.getsize(path) / 1024
    total = sum(len(m["idx"]) // 3 for m in data.values())
    print("%-24s %2d Modelle, %6d Dreiecke, %7.1f KB" % (name, len(data), total, size))


def main():
    source = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SOURCE
    if not os.path.isdir(source):
        raise SystemExit("Quellordner fehlt: %s" % source)

    connectors = {}
    for key, (rel, mask) in CONNECTORS.items():
        mesh = convert(os.path.join(source, rel))
        mesh["mask"] = mask
        connectors[key] = mesh
    write("connectors.json", connectors)

    slides = {key: convert(os.path.join(source, rel)) for key, rel in SLIDES.items()}
    write("slides.json", slides)


if __name__ == "__main__":
    main()
