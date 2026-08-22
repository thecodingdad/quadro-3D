// Lädt die aus der Herstellersoftware abgegriffenen 3D-Modelle
// (`data/models/*.json`, erzeugt von `tools/obj2mesh.py`).
//
// Bewusst OHNE Three.js: hier entstehen nur rohe Zahlenfelder, die
// `BufferGeometry` baut `scene.js` daraus -- Three.js bleibt damit auf eine
// Datei beschränkt. Geladen wird erst NACH dem ersten Bild; bis dahin (und
// wenn eine Datei fehlt) zeichnet die Szene wie bisher ihre eigenen Formen.

// Die Datei führt Positionen in 0,1 mm; der Editor rechnet in Zentimetern.
const POS_TO_CM = 1 / 100;
const NRM_SCALE = 1 / 1000;

const stores = {};   // Dateiname -> Promise auf { name -> record }

/**
 * Ein Modell: `pos`/`nrm` als Float32Array (Position in cm), `idx` als
 * Uint16Array. `mask` gibt es nur bei Kupplungen -- die Bitfolge ihrer Arme.
 */
function toRecord(raw) {
  const pos = new Float32Array(raw.pos.length);
  for (let i = 0; i < raw.pos.length; i++) pos[i] = raw.pos[i] * POS_TO_CM;
  const nrm = new Float32Array(raw.nrm.length);
  for (let i = 0; i < raw.nrm.length; i++) nrm[i] = raw.nrm[i] * NRM_SCALE;
  return { pos, nrm, idx: new Uint16Array(raw.idx), mask: raw.mask };
}

function load(file) {
  if (!stores[file]) {
    stores[file] = fetch(`../data/models/${file}`)
      .then((res) => {
        if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        const out = {};
        for (const key of Object.keys(data)) out[key] = toRecord(data[key]);
        return out;
      })
      .catch((e) => {
        // Kein harter Fehler: ohne Modelle bleibt es bei den gezeichneten Formen.
        console.info("Modelle nicht geladen:", e.message);
        return null;
      });
  }
  return stores[file];
}

/** Kupplungen, nach Katalog-Kennung ("straight", "t", "6way" ...). */
export function loadConnectorMeshes() {
  return load("connectors.json");
}

/** Rohre, nach QDF-Elementart -- bisher nur das Bogenrohr ("round-tube2"). */
export function loadTubeMeshes() {
  return load("tubes.json");
}

/** Rutschen und Dächer, nach QDF-Elementart ("slide2", "roof2" ...). */
export function loadSlideMeshes() {
  return load("slides.json");
}
