// Service Worker: macht den Editor offline lauffähig.
//
// Strategie ist bewusst NETZ ZUERST: der Editor wird oft direkt aus dem
// Arbeitsverzeichnis serviert, und ein Cache, der alte ES-Module ausliefert,
// kostet mehr Zeit, als er spart. Erst wenn das Netz nicht antwortet, kommt
// die Kopie aus dem Cache -- und genau dann zählt sie.
//
// Der Worker liegt im Wurzelverzeichnis, damit sein Geltungsbereich sowohl
// `web/` (App) als auch `data/` (Teilekatalog) umfasst.

const CACHE = "quadro-v1";

// Alles, was die App zum Starten braucht. Pfade relativ zu dieser Datei, damit
// es auch unter GitHub Pages in einem Unterordner passt.
const SCHALE = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "data/parts.json",
  "data/models/connectors.json",
  "data/models/fittings.json",
  "data/models/slides.json",
  "data/models/surfaces.json",
  "data/models/tubes.json",
  "web/index.html",
  "web/css/style.css",
  "web/vendor/three/three.module.js",
  "web/vendor/three/OrbitControls.js",
  "web/js/main.js",
  "web/js/bom.js",
  "web/js/builder.js",
  "web/js/buildplan.js",
  "web/js/catalog.js",
  "web/js/config.js",
  "web/js/docs.js",
  "web/js/i18n.js",
  "web/js/library.js",
  "web/js/model.js",
  "web/js/qdfexport.js",
  "web/js/qdfimport.js",
  "web/js/meshes.js",
  "web/js/scene.js",
  "web/js/storage.js",
  "web/js/sync.js",
  "web/js/ui.js",
  "web/js/util.js",
];

self.addEventListener("install", (e) => {
  // Einzeln laden: eine fehlende Datei soll nicht die ganze Installation
  // scheitern lassen (sonst bliebe die App ohne Worker).
  e.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(SCHALE.map((p) => cache.add(p).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((namen) => Promise.all(namen.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  // Die Backend-Schnittstelle bleibt außen vor: eine zwischengespeicherte
  // Dateiliste wäre offline eine Behauptung, keine Wahrheit -- und der
  // Abgleich in sync.js muss merken, dass der Server nicht antwortet.
  if (url.pathname.includes("/api/")) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        // Frische Antwort nebenbei in den Cache legen -- das ist der Vorrat
        // für den nächsten Start ohne Netz.
        if (res.ok) {
          const kopie = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, kopie));
        }
        return res;
      })
      .catch(() => caches.match(req).then((treffer) => treffer || caches.match("web/index.html")))
  );
});
