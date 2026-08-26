#!/usr/bin/env python3
"""QUADRO 3D mit Backend: statische App + Datei-API + Ereignis-Kanal.

Der Server liefert dasselbe Arbeitsverzeichnis aus wie `serve.py` und zusaetzlich
unter `/api/` die gemeinsame Ablage fuer gespeicherte Modelle und die
QDF-Bibliothek. Beides aus EINEM Ursprung -- damit braucht der Browser weder
CORS noch eine konfigurierte Adresse: liegt die App auf diesem Server, findet
sie die API; liegt sie woanders (GitHub Pages, `serve.py`), findet sie keine und
arbeitet rein lokal weiter.

    python server.py             # Port 8000
    python server.py 8090        # anderer Port
    QUADRO_DATA=/data python server.py

Der Datenbestand liegt als gewoehnliche Dateien unter QUADRO_DATA (Vorgabe
`./data-store`) -- lesbar, sicherbar, ohne Datenbank:

    docs/<id>.json          {id,name,data,createdAt,updatedAt,rev}
    inventory.json          {data,rev,updatedAt} -- der eigene Teilebestand
    library/<hash>.qdf      Originaltext der Sammlung
    library/index.json      {id: {name,file,meta,rev}}

Jede Datei traegt eine Revision (`rev`). Geschrieben wird nur, wenn der Client
die aktuelle Revision kennt -- sonst antwortet der Server 409 und der Browser
fragt nach. Aenderungen gehen als kurze Ereignisse ueber den WebSocket an alle
verbundenen Browser; die Daten selbst holen sie sich per HTTP.
"""

import asyncio
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

from aiohttp import web, WSMsgType

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("QUADRO_DATA") or (ROOT / "data-store")).resolve()

# Datei-Kennungen kommen vom Browser. Nur harmlose Zeichen zulassen, sonst
# waere ein "../" in der Kennung ein Weg aus dem Datenverzeichnis.
SAFE_ID = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")

# Fassung der Schnittstelle -- zaehlt fuer sich, unabhaengig von der Fassung
# der App (SemVer, Datei `VERSION`). Fehlt die Datei (blosse Kopie einzelner
# Dateien), laeuft der Server trotzdem an und meldet "0.0.0".
API_VERSION = 1


def read_app_version():
    try:
        return (ROOT / "VERSION").read_text(encoding="utf-8").strip() or "0.0.0"
    except OSError:
        return "0.0.0"


APP_VERSION = read_app_version()


def now_ms():
    return int(time.time() * 1000)


def canonical(value):
    """Vergleichbare Fassung eines Modells -- Reihenfolge der Schluessel egal."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def write_atomic(path: Path, text: str):
    """Erst daneben schreiben, dann umbenennen: nie eine halbe Datei auf Platte."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


# --- Ablage ---------------------------------------------------------------

class Store:
    """Dateibasierte Ablage. Alle Schreibzugriffe laufen unter EINEM Lock."""

    def __init__(self, root: Path):
        self.root = root
        self.docs_dir = root / "docs"
        self.lib_dir = root / "library"
        self.lib_index = self.lib_dir / "index.json"
        self.docs_dir.mkdir(parents=True, exist_ok=True)
        self.lib_dir.mkdir(parents=True, exist_ok=True)

    # --- Modelle ---------------------------------------------------------

    def _doc_path(self, doc_id: str) -> Path:
        return self.docs_dir / f"{doc_id}.json"

    def get_doc(self, doc_id: str):
        path = self._doc_path(doc_id)
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return None

    def list_docs(self):
        rows = []
        for path in sorted(self.docs_dir.glob("*.json")):
            try:
                doc = json.loads(path.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                continue
            rows.append({k: doc.get(k) for k in ("id", "name", "rev", "createdAt", "updatedAt")})
        return rows

    def put_doc(self, doc_id, name, data, base_rev, force=False):
        """Liefert (status, record) mit status "ok" | "unchanged" | "conflict"."""
        old = self.get_doc(doc_id)
        if old is None:
            # Die Datei gibt es nicht (mehr). Wer eine Revision erwartet, hat sie
            # anderswo geloescht bekommen -- das ist ein Konflikt, kein Anlegen.
            if base_rev and not force:
                return "conflict", None
            record = {
                "id": doc_id, "name": name, "data": data,
                "createdAt": now_ms(), "updatedAt": now_ms(), "rev": 1,
            }
            write_atomic(self._doc_path(doc_id), json.dumps(record, ensure_ascii=False))
            return "ok", record

        # Nichts geaendert? Dann keine neue Revision und kein Ereignis -- sonst
        # wandert eine Datei allein durchs Oeffnen in jeder Liste nach oben.
        if old.get("name") == name and canonical(old.get("data")) == canonical(data):
            return "unchanged", old

        if not force and base_rev != old.get("rev"):
            return "conflict", old

        record = dict(old)
        record.update({"name": name, "data": data, "updatedAt": now_ms(),
                       "rev": int(old.get("rev") or 0) + 1})
        write_atomic(self._doc_path(doc_id), json.dumps(record, ensure_ascii=False))
        return "ok", record

    def delete_doc(self, doc_id, rev, force=False):
        old = self.get_doc(doc_id)
        if old is None:
            return "ok", None                      # schon weg -- nichts zu tun
        if not force and rev != old.get("rev"):
            return "conflict", old
        self._doc_path(doc_id).unlink(missing_ok=True)
        return "ok", old

    # --- Bestand ---------------------------------------------------------
    # Ein einziger kleiner Datensatz, gleiche Revisionsregel wie bei Modellen.

    @property
    def _inventory_path(self) -> Path:
        return self.root / "inventory.json"

    def get_inventory(self):
        path = self._inventory_path
        if not path.exists():
            return {"data": {}, "rev": 0, "updatedAt": 0}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return {"data": {}, "rev": 0, "updatedAt": 0}

    def put_inventory(self, data, base_rev, force=False):
        old = self.get_inventory()
        if canonical(old.get("data")) == canonical(data):
            return "unchanged", old
        if not force and base_rev != old.get("rev"):
            return "conflict", old
        record = {"data": data, "rev": int(old.get("rev") or 0) + 1, "updatedAt": now_ms()}
        write_atomic(self._inventory_path, json.dumps(record, ensure_ascii=False))
        return "ok", record

    # --- Bibliothek ------------------------------------------------------
    # Die Kennung eines Eintrags kommt aus Dateiname und -groesse ("Haus.qdf|8123")
    # und taugt nicht als Dateiname. Der Text landet deshalb unter dem SHA1 der
    # Kennung, die Zuordnung steht im Index.

    def _lib_file(self, entry_id: str) -> Path:
        return self.lib_dir / (hashlib.sha1(entry_id.encode("utf-8")).hexdigest() + ".qdf")

    def _read_index(self):
        if not self.lib_index.exists():
            return {}
        try:
            return json.loads(self.lib_index.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return {}

    def _write_index(self, index):
        write_atomic(self.lib_index, json.dumps(index, ensure_ascii=False))

    def list_library(self):
        index = self._read_index()
        return [{"id": eid, **{k: row.get(k) for k in ("name", "file", "meta", "rev")}}
                for eid, row in sorted(index.items(), key=lambda kv: (kv[1].get("name") or "").lower())]

    def get_library(self, entry_id):
        index = self._read_index()
        row = index.get(entry_id)
        if not row:
            return None
        path = self._lib_file(entry_id)
        qdf = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
        return {"id": entry_id, "name": row.get("name"), "file": row.get("file"),
                "meta": row.get("meta"), "rev": row.get("rev"), "qdf": qdf}

    def put_library(self, entries):
        """Eintraege ablegen (gleiche Kennung ueberschreibt). Liefert die Kennungen."""
        index = self._read_index()
        added = []
        for entry in entries:
            entry_id = entry.get("id")
            if not entry_id or not isinstance(entry_id, str):
                continue
            write_atomic(self._lib_file(entry_id), entry.get("qdf") or "")
            index[entry_id] = {
                "name": entry.get("name") or entry_id,
                "file": entry.get("file") or "",
                "meta": entry.get("meta") or {},
                "rev": int(index.get(entry_id, {}).get("rev") or 0) + 1,
            }
            added.append(entry_id)
        if added:
            self._write_index(index)
        return added

    def delete_library(self, entry_id):
        index = self._read_index()
        if entry_id not in index:
            return []
        self._lib_file(entry_id).unlink(missing_ok=True)
        del index[entry_id]
        self._write_index(index)
        return [entry_id]

    def clear_library(self):
        index = self._read_index()
        removed = list(index.keys())
        for entry_id in removed:
            self._lib_file(entry_id).unlink(missing_ok=True)
        self._write_index({})
        return removed


store = Store(DATA)
write_lock = asyncio.Lock()

# --- Ereignis-Kanal -------------------------------------------------------
# Alle offenen WebSockets. Gesendet wird nur die Nachricht "das hat sich
# geaendert" -- die Daten holen sich die Browser per HTTP. Damit bleibt der
# Kanal klein und ein Ausfall kostet nur die Sofort-Meldung, nicht das Arbeiten.

sockets = set()


async def broadcast(event: dict):
    for ws in list(sockets):
        try:
            await ws.send_json(event)
        except (ConnectionResetError, RuntimeError):
            sockets.discard(ws)


# --- API ------------------------------------------------------------------

def json_response(data, status=200):
    return web.json_response(data, status=status, dumps=lambda v: json.dumps(v, ensure_ascii=False))


async def read_json(request):
    try:
        return await request.json()
    except (ValueError, TypeError):
        raise web.HTTPBadRequest(text="kein JSON")


def check_id(doc_id):
    if not SAFE_ID.match(doc_id or ""):
        raise web.HTTPBadRequest(text="ungueltige Kennung")
    return doc_id


async def health(request):
    return json_response({"ok": True, "api": API_VERSION, "app": APP_VERSION, "name": "quadro-3d"})


async def docs_list(request):
    return json_response(store.list_docs())


async def doc_get(request):
    doc = store.get_doc(check_id(request.match_info["id"]))
    if doc is None:
        raise web.HTTPNotFound(text="unbekannte Datei")
    return json_response(doc)


async def doc_put(request):
    doc_id = check_id(request.match_info["id"])
    body = await read_json(request)
    name = (body.get("name") or "").strip() or "Unbenannt"
    data = body.get("data")
    if data is None:
        raise web.HTTPBadRequest(text="data fehlt")
    base_rev = int(body.get("baseRev") or 0)
    force = bool(body.get("force"))
    async with write_lock:
        status, record = store.put_doc(doc_id, name, data, base_rev, force)
    if status == "conflict":
        return json_response({"conflict": True, "current": record}, status=409)
    if status == "unchanged":
        return json_response({**record, "unchanged": True})
    await broadcast({"type": "doc-saved", "id": record["id"], "rev": record["rev"],
                     "name": record["name"], "updatedAt": record["updatedAt"],
                     "by": body.get("clientId") or ""})
    return json_response(record)


async def doc_delete(request):
    doc_id = check_id(request.match_info["id"])
    rev = int(request.query.get("rev") or 0)
    force = request.query.get("force") == "1"
    async with write_lock:
        status, record = store.delete_doc(doc_id, rev, force)
    if status == "conflict":
        return json_response({"conflict": True, "current": record}, status=409)
    if record is not None:
        await broadcast({"type": "doc-deleted", "id": doc_id,
                         "by": request.query.get("clientId") or ""})
    return web.Response(status=204)


async def inventory_get(request):
    return json_response(store.get_inventory())


async def inventory_put(request):
    body = await read_json(request)
    data = body.get("data")
    if data is None:
        raise web.HTTPBadRequest(text="data fehlt")
    async with write_lock:
        status, record = store.put_inventory(data, int(body.get("baseRev") or 0), bool(body.get("force")))
    if status == "conflict":
        return json_response({"conflict": True, "current": record}, status=409)
    if status == "unchanged":
        return json_response({**record, "unchanged": True})
    await broadcast({"type": "inv-changed", "rev": record["rev"], "by": body.get("clientId") or ""})
    return json_response(record)


async def library_list(request):
    return json_response(store.list_library())


async def library_get(request):
    entry = store.get_library(request.match_info["id"])
    if entry is None:
        raise web.HTTPNotFound(text="unbekannter Eintrag")
    return json_response(entry)


async def library_post(request):
    body = await read_json(request)
    entries = body.get("entries")
    if not isinstance(entries, list):
        raise web.HTTPBadRequest(text="entries fehlt")
    async with write_lock:
        added = store.put_library(entries)
    if added:
        await broadcast({"type": "lib-changed", "added": added, "removed": [],
                         "by": body.get("clientId") or ""})
    return json_response({"added": added})


async def library_delete(request):
    entry_id = request.match_info["id"]
    async with write_lock:
        removed = store.delete_library(entry_id)
    if removed:
        await broadcast({"type": "lib-changed", "added": [], "removed": removed,
                         "by": request.query.get("clientId") or ""})
    return web.Response(status=204)


async def library_clear(request):
    async with write_lock:
        removed = store.clear_library()
    if removed:
        await broadcast({"type": "lib-changed", "added": [], "removed": removed,
                         "by": request.query.get("clientId") or ""})
    return web.Response(status=204)


async def websocket(request):
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    sockets.add(ws)
    try:
        await ws.send_json({"type": "welcome", "api": API_VERSION})
        async for msg in ws:
            # Der Kanal ist einseitig gedacht; eingehende Nachrichten dienen nur
            # dazu, die Verbindung am Leben zu halten.
            if msg.type == WSMsgType.ERROR:
                break
    finally:
        sockets.discard(ws)
    return ws


# --- Statische App --------------------------------------------------------

@web.middleware
async def no_store(request, handler):
    """Wie serve.py: nichts zwischenspeichern, sonst laufen alte ES-Module mit."""
    response = await handler(request)
    response.headers.setdefault("Cache-Control", "no-store")
    return response


def build_app():
    app = web.Application(middlewares=[no_store], client_max_size=64 * 1024 * 1024)
    app.router.add_get("/api/health", health)
    app.router.add_get("/api/docs", docs_list)
    app.router.add_get("/api/docs/{id}", doc_get)
    app.router.add_put("/api/docs/{id}", doc_put)
    app.router.add_delete("/api/docs/{id}", doc_delete)
    app.router.add_get("/api/inventory", inventory_get)
    app.router.add_put("/api/inventory", inventory_put)
    app.router.add_get("/api/library", library_list)
    app.router.add_post("/api/library", library_post)
    app.router.add_delete("/api/library", library_clear)
    app.router.add_get("/api/library/{id}", library_get)
    app.router.add_delete("/api/library/{id}", library_delete)
    app.router.add_get("/api/ws", websocket)

    # Statisch wird NUR ausgeliefert, was die App wirklich braucht. Das ganze
    # Arbeitsverzeichnis freizugeben waere bequem, gaebe aber auch `.git/`,
    # `server.py`, eigene QDF-Sammlungen und (bei der Vorgabe `./data-store`)
    # den gesamten Datenbestand ungefragt heraus.
    for route, folder in (("/web", ROOT / "web"), ("/data", ROOT / "data"), ("/icons", ROOT / "icons")):
        if folder.is_dir():
            app.router.add_static(route, folder, show_index=False, follow_symlinks=False)
    for route, file in (("/", ROOT / "index.html"),
                        ("/index.html", ROOT / "index.html"),
                        ("/manifest.webmanifest", ROOT / "manifest.webmanifest"),
                        ("/sw.js", ROOT / "sw.js")):
        app.router.add_get(route, lambda request, target=file: web.FileResponse(target))
    return app


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("QUADRO_PORT") or 8000)
    print("=" * 56)
    print(f"  QUADRO 3D {APP_VERSION} (mit Backend)")
    print(f"  App:    http://127.0.0.1:{port}/web/index.html")
    print(f"  API:    http://127.0.0.1:{port}/api/health")
    print(f"  Daten:  {DATA}")
    print("  Beenden: Strg + C")
    print("=" * 56)
    web.run_app(build_app(), host="0.0.0.0", port=port, print=None)


if __name__ == "__main__":
    main()
