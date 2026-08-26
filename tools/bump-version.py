#!/usr/bin/env python3
"""Setzt die Fassung der App (SemVer) an allen drei Stellen zugleich.

Kein Build-Step: das Skript laeuft von Hand, wenn ein Release ansteht.
Gepflegt werden

    VERSION              die Einzelquelle
    web/js/config.js     export const APP_VERSION = "..."
    sw.js                const CACHE = "quadro-v..."

Danach:

    python3 tools/bump-version.py 1.1.0
    git commit -am "Release 1.1.0"
    git tag v1.1.0
    git push --follow-tags

Der Release-Workflow prueft, dass Tag und die drei Stellen uebereinstimmen --
laufen sie auseinander, entsteht weder Image noch Release.

Ohne Argument sagt das Skript nur, was gerade eingetragen ist.
"""

import os
import re
import sys

WURZEL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

VERSION_DATEI = os.path.join(WURZEL, "VERSION")
CONFIG_DATEI = os.path.join(WURZEL, "web", "js", "config.js")
SW_DATEI = os.path.join(WURZEL, "sw.js")

# SemVer, wie der Workflow ihn erwartet: 1.2.3 mit optionaler Vorabfassung
# (1.2.3-rc.1). Ein Aufbau-Anhang (+build) bleibt draussen -- er darf in einem
# Docker-Tag nicht vorkommen.
SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")

CONFIG_MUSTER = re.compile(r'(export const APP_VERSION = ")([^"]*)(";)')
SW_MUSTER = re.compile(r'(const CACHE = "quadro-v)([^"]*)(";)')


def lies(pfad):
    with open(pfad, encoding="utf-8") as f:
        return f.read()


def schreib(pfad, text):
    with open(pfad, "w", encoding="utf-8") as f:
        f.write(text)


def stand():
    """Was steht gerade wo? Liefert {Anzeigename: Fassung}."""
    aus = {}
    aus["VERSION"] = lies(VERSION_DATEI).strip() if os.path.exists(VERSION_DATEI) else None
    treffer = CONFIG_MUSTER.search(lies(CONFIG_DATEI))
    aus["web/js/config.js"] = treffer.group(2) if treffer else None
    treffer = SW_MUSTER.search(lies(SW_DATEI))
    aus["sw.js"] = treffer.group(2) if treffer else None
    return aus


def setze(neu):
    """Alle drei Stellen auf `neu` bringen. Liefert die geaenderten Dateien."""
    geaendert = []

    if not os.path.exists(VERSION_DATEI) or lies(VERSION_DATEI).strip() != neu:
        schreib(VERSION_DATEI, neu + "\n")
        geaendert.append("VERSION")

    for pfad, muster, name in ((CONFIG_DATEI, CONFIG_MUSTER, "web/js/config.js"),
                               (SW_DATEI, SW_MUSTER, "sw.js")):
        text = lies(pfad)
        if not muster.search(text):
            sys.exit(f"FEHLER: In {name} steht die erwartete Zeile nicht mehr.")
        ersetzt = muster.sub(lambda m: m.group(1) + neu + m.group(3), text, count=1)
        if ersetzt != text:
            schreib(pfad, ersetzt)
            geaendert.append(name)

    return geaendert


def main():
    if len(sys.argv) < 2:
        for name, fassung in stand().items():
            print(f"  {name:<20} {fassung or '?'}")
        print("\nSetzen:  python3 tools/bump-version.py 1.1.0")
        return

    neu = sys.argv[1].lstrip("v").strip()
    if not SEMVER.match(neu):
        sys.exit(f"FEHLER: '{neu}' ist kein SemVer (erwartet z. B. 1.2.3 oder 1.2.3-rc.1).")

    geaendert = setze(neu)
    if geaendert:
        print("Geaendert: " + ", ".join(geaendert))
    else:
        print(f"Alles steht schon auf {neu}.")

    print(f"""
Naechste Schritte:

    git commit -am "Release {neu}"
    git tag v{neu}
    git push --follow-tags
""".rstrip())


if __name__ == "__main__":
    main()
