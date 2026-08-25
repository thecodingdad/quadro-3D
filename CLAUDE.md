# CLAUDE.md

QUADRO 3D – Planungstool für QUADRO-Klettergerüste. Reine Vanilla-JS-Web-App,
**kein Build-Step, kein npm, keine Frameworks**, läuft offline aus dem Dateisystem eines
statischen Servers. Nutzerdoku: `README.md`, Historie: `CHANGELOG.md`.

## Starten & Verifizieren

```bash
python serve.py            # Port 8000, öffnet http://127.0.0.1:8000/web/index.html
python serve.py 8080       # anderer Port
python server.py 8000      # dasselbe PLUS optionales Backend (braucht aiohttp)
```

Nie `web/index.html` per `file://` öffnen – Browser blockieren dort ES-Module und `fetch()`.
Three.js r160 + OrbitControls liegen gevendort unter `web/vendor/three/` (kein Netz nötig).

### Eigener Dev-Server (der einzige Ort zum Prüfen)

**http://nuc-quadro gehört dem Nutzer – dort wird nicht getestet, auch nicht „nur kurz".**
Zum Prüfen einen **eigenen** Server aus diesem Arbeitsverzeichnis starten und ihn per Chrome MCP
(`navigate_page`, `take_screenshot`, `list_console_messages`, `evaluate_script`) ansteuern:

```bash
python serve.py 8090                                   # ohne Backend
QUADRO_DATA=<scratchpad>/store python server.py 8090   # mit Backend
```

Der Chrome-Container erreicht ihn über die **IP dieses Containers**, nicht über `localhost`
(`hostname -i`, zuletzt `http://192.168.168.119:8090/web/index.html`). Datenverzeichnis in den
Scratchpad legen, nie ins Repo. Für das Backend braucht es `aiohttp` – in dieser Umgebung fehlt
`pip`, es lässt sich aber per `get-pip.py` in ein `venv` im Scratchpad nachrüsten.

**Wichtig:** Nach jeder Code-Änderung den Browser-Cache umgehen, sonst lädt die Seite alte
ES-Module. Entweder `navigate_page` mit `type: "reload"` **und `ignoreCache: true`**, oder per
`evaluate_script` ein Cache-Buster (`location.href = location.pathname + '?v=' + Date.now()`,
mit `?dev` kombinierbar).

Der Chromium-Container läuft ohne GPU und rendert WebGL über SwiftShader
(`CHROME_CLI=--enable-unsafe-swiftshader --use-angle=swiftshader`, `shm_size: 1gb`). Das 3D-Bild
ist damit voll prüfbar, nur langsam. Fehlt das Flag, scheitert Three.js mit
`A WebGL context could not be created` – dann ist die Container-Config schuld, nicht der Code.

Nützlich zur Diagnose: `renderer.info.render` (Draw Calls/Dreiecke) zeigt, ob Three.js überhaupt
zeichnet; `gl.readPixels` beweist Bildinhalt unabhängig vom Screenshot-Pfad. Mit `?dev` steht
`window.__qdf` mit `{ model, builder, scene, import(qdfText) }` bereit.

### Statische Prüfungen

Es gibt **keine Testsuite und keinen Linter**. Verifikation:

```bash
python -m json.tool data/parts.json > /dev/null && echo OK
node --check web/js/model.js && node --check web/js/bom.js && node --check web/js/buildplan.js
```

`model.js`, `bom.js`, `buildplan.js`, `qdfimport.js`, `qdfexport.js` und `library.js` sind bewusst
frei von Three.js und DOM
und dadurch in Node isoliert testbar/ausführbar. **Diese Trennung beim Erweitern halten** –
Three.js ausschließlich in `scene.js`, DOM ausschließlich in `ui.js`/`scene.js`/`storage.js`.

## Architektur

| Datei | Aufgabe |
|---|---|
| `web/js/main.js` | Bootstrap: Katalog → Scene → Model → Builder → UI, Autosave-Verdrahtung |
| `web/js/config.js` | Konstanten: `DIRECTIONS`, `DIAGONAL_DIRECTIONS`, Toleranzen, `AUTOSAVE_KEY`, `FORMAT_VERSION` |
| `web/js/catalog.js` | Einziger Ort, der `data/parts.json` kennt; `getTube/getConnector/getPanel/colorHex/spacingFor/gridSpacing` |
| `web/js/i18n.js` | DE/EN-Dictionaries, `t()`, `setLang()`, `applyTranslations()` |
| `web/js/model.js` | Datenmodell (Graph), Auto-Merge, Kollisionsprüfung, `findRectangles`, `toJSON`/`loadJSON` |
| `web/js/bom.js` | Stückliste, Kupplungstyp-Heuristik, Verstärkungs-Profile, Bestandsvergleich |
| `web/js/buildplan.js` | Aufbauplan: Modell Lage für Lage in Bauschritte zerlegen |
| `web/js/scene.js` | Three.js: Renderer, Kamera, Rendering, Raycasting, Handles, Label-Sprites, Umgebung (Gras/Bäume/Himmel) |
| `web/js/meshes.js` | Lädt `data/models/*.json` (die aus `Quadro.exe` abgegriffenen Modelle) als rohe Zahlenfelder – **ohne** Three.js |
| `web/js/builder.js` | Interaktion: Auswahl, Handles, Setzen/Löschen, Modi, Undo/Redo |
| `web/js/storage.js` | IndexedDB-Zugriff (`dbTx`), Modell-Sammlung, Datei-Export/Import |
| `web/js/docs.js` | Virtuelle Dateien: Modelle speichern/laden/umbenennen, offene Sitzung, Migration |
| `web/js/sync.js` | Abgleich mit dem optionalen Backend: Suche (`probe`), WebSocket-Ereignisse, `reconcile`, Konflikte |
| `server.py` | Optionales Backend (aiohttp): statische App + `/api/` + Ereignis-Kanal, Ablage als Dateien |
| `web/js/ui.js` | Toolbar, Datei-Tabs, Seitenleiste (Stückliste & Bestand / Modelle / Aufbau), Tastatur |
| `web/js/qdfimport.js` | Parser für QDF-Dateien der Original-QUADRO-3D-Software (Format: `QDF-FORMAT.md`) |
| `web/js/qdfexport.js` | Schreibt ein Modell als QDF (Gegenstück zu `qdfimport.js`) |
| `web/js/library.js` | Modell-Bibliothek: QDF-Sammlung einlesen, Kennzahlen, Bestandsabgleich |
| `manifest.webmanifest` | PWA-Manifest (Wurzel, damit `scope` auch `data/` umfasst) |
| `sw.js` | Service Worker: Netz zuerst, Cache als Rückfall – macht die App offline lauffähig |
| `tools/make-icons.py` | Erzeugt die Symbole in `icons/` (nur von Hand, kein Build-Step) |
| `tools/obj2mesh.py` | Wandelt die abgegriffenen OBJ-Modelle in `data/models/*.json` (nur von Hand, kein Build-Step) |

**Datenfluss:** Jede Modelländerung → `builder.refresh()` → `scene.renderModel()` + Handles neu →
`builder.onChange()` → (in `main.js`) `ui.update()` + `ui.touchActiveTab()` (markiert den Tab,
sichert die Sitzung und – bei eingeschaltetem Auto-Save – die Datei).

**Mehrere Modelle:** Ein Tab hält ein Modell samt Werkzeugleiste, Ansicht und Schrittspeicher
(`builder.uiState()`/`setUiState()`). Umgeschaltet wird über EIN `BuildModel` und EINEN `Builder`:
Stand des alten Tabs sichern (`model.toJSON()`, Kamera, Schnittebene), Stand des neuen einsetzen.

**PWA:** `web/index.html` verweist auf `../manifest.webmanifest`, `main.js` meldet `../sw.js` an –
beide relativ, damit es unter GitHub Pages im Unterordner passt. Mit `?dev` wird der Worker
**nicht** angemeldet, und ohne sicheren Kontext (http:// auf einem fremden Host) lehnt der Browser
ihn ab; dann fehlen Offline-Betrieb und Installieren-Knopf, die App selbst läuft normal.

**Optionales Backend (ein Datenbestand!):** Die App liest und schreibt **immer** IndexedDB –
auch mit Server. `sync.js` hält diese Kopie mit `server.py` im Gleichklang: `probe()` beim Start
(`GET ../api/health`, 1,5 s Zeitgrenze), danach `reconcile()` bei jedem Verbinden, nach jeder
lokalen Änderung (`nudge()`, entprellt) und bei jedem Ereignis vom Server. Es gibt **keinen**
Umschaltbetrieb „Server-Daten vs. Browser-Daten": ohne Server läuft alles mit dem gecachten
Bestand weiter, Änderungen bleiben `dirty` liegen und gehen beim nächsten Verbinden hoch.

Dafür tragen die Datensätze in `docs`/`designs` drei Felder: `rev` (Revision, aus der der Inhalt
stammt, 0 = dem Server unbekannt), `dirty` (noch nicht hochgeladen) und `deletedAt` (Grabstein,
bis der Server die Löschung übernommen hat). Gefragt wird **nur** bei echten Konflikten – wenn
beide Seiten dieselbe Datei geändert haben (`onConflict` in `ui.js`, serielle Warteschlange, weil
ein zweiter `dialog()` den ersten abbricht). Der Server vergibt `rev` und lehnt ein Schreiben mit
veralteter `baseRev` mit **409** ab; ist der Inhalt identisch, bleibt `rev` stehen und es gibt
kein Ereignis.

Abgeglichen werden **Modelle, Bestand und Bibliothek**. Der Bestand ist ein einziger Datensatz
(`/api/inventory`) und liegt weiter in localStorage, seine Marken daneben in
`quadro.inventory.meta.v1`. Die Bibliothek liefert Kennzahlen sofort, den QDF-Text erst beim
Öffnen (`sync.libQdf`) – ohne Server wirft das `OfflineError` und die App meldet es.

`server.py` ist **ungeschützt** (keine Anmeldung, keine Rechte, kein TLS) und gehört ins eigene
Netz – siehe README. Statisch liefert er deshalb nur `/web`, `/data`, `/icons` und die drei
Dateien im Wurzelverzeichnis aus, **nicht** das ganze Arbeitsverzeichnis: sonst lägen `.git/`,
eigene QDF-Sammlungen und (bei der Vorgabe `./data-store`) der Datenbestand offen.

Sichtbar ist der Abgleich an **einer** Stelle: der Zeile `#sync-state` im Seitenleisten-Tab
„Meine Modelle". Sie bleibt versteckt, bis in dieser Sitzung einmal eine Verbindung stand – ohne
Server meldet die App nichts, danach aber sehr wohl den Verlust. Abschalten lässt sich das
Backend nur über `?nobackend`; einen Schalter in den Einstellungen gibt es bewusst nicht.

## Datenmodell

Koordinaten in **cm**, Three.js-Konvention **y = oben**, Boden bei y = 0.

`BuildModel` hält sieben Maps: `nodes`, `tubes`, `panels`, `clamps`, `textiles`, `slides`, `fittings`.

- Knoten `{id,x,y,z}` = Kupplung. Optionale Flags: `c45` (trägt 45°-Winkelkupplung),
  `c45body` (Adapter-Körper), `c45axis`, `armDirs`/`arms` (rotierte Kupplung aus QDF), `quat`.
- Kante `{id,a,b,tubeId,color,length,reinforced}` = Rohr. **Zwei Sonderkanten sind keine Rohre**
  und zählen nicht in der Stückliste:
  - `arm: true` – kurze Hülse zwischen Eck-Kupplung und C45-Adapterkörper
  - `link: true` – Verbindung zweier paralleler Rohre im Doppelrohrverbinder
- Platte `{id,a,b,t0,len,panelId,color,side}` – hängt an **zwei parallelen Rohren** (`a`,`b`), `t0`
  ist der Versatz entlang Rohr `a`, `len` die Länge in Rohrrichtung. `model.panelCorners(p)` liefert
  daraus die vier Ecken; sie müssen nicht auf Kupplungen liegen. `_prunePanels` entfernt die Platte,
  sobald eines der Tragrohre fehlt. Ältere Stände mit `nodes:[4]` werden in `loadJSON` umgerechnet
  (`_panelRecord`). `side` = +1 oben bzw. außen (Standard), −1 unten bzw.
  innen. Die Platte schließt **bündig** mit dem Rohr ab (Oberfläche auf Rohrscheitel), sie liegt
  also nicht darauf; Bezugsrichtung ist `util.panelNormal()` (waagerecht → oben,
  senkrecht → vom Modellmittelpunkt weg). Beim Setzen entscheidet der Blickwinkel, ein Klick auf
  eine liegende Platte legt sie um.
- Anbauteil `{id,kind,x,y,z,quat,color,w?,h?,d?,mask?}` = Rad, Rolle, Lager, Netz, Rundabdeckung, Bällebad …
  `kind` ist die QDF-Elementart, `quat` die volle Ausrichtung (Three-Reihenfolge x,y,z,w); die lokale
  +X-Achse ist die Bezugsrichtung (Radachse, Rollenachse). Wo ein Teil sitzen darf, steht in
  `FITTING_MOUNTS` (Kupplung oder Rohr, Abstand in cm) bzw. in eigenen Abläufen für Netz
  (zwei parallele Rohre), Rundabdeckung (zwei Bogenrohre) und großes Dach (First-Rohr).
- **Auto-Merge:** `addNode` liefert einen vorhandenen Knoten zurück, wenn einer < `MERGE_EPS`
  (0,5 cm) existiert – so entstehen geschlossene Rahmen ohne Doppelteile.
- **Abstand Mitte–Mitte** = Rohrlänge + `geometry.connectorSize` (5 cm) → `spacingFor()`.
  35er-Rohr ⇒ 40-cm-Raster (passend zur 40×40-Platte).
- `extend()` liefert drei Fälle: gebaut, `{duplicate:true}` (Ziel bereits verbunden ⇒ reine
  Navigation) oder `{collision:true}` (`tubeCollision` prüft kollineare Überlappung **und**
  Kreuzungen im Rohrinneren).
- Schrägen sind **immer 45°** (`DIAGONAL_DIRECTIONS`). Im Editor gebaute Schrägen laufen über
  `extendC45Diagonal` (Basiskupplung → Adapter-Arm → Adapterkörper → Diagonalrohr); an bereits
  rotierten Kupplungen greift `extendDiagonalSnap` mit größerer Toleranz.
- `loadJSON` gibt `{ok, reason}` zurück (`"data"` / `"format"`), statt still ein kaputtes Modell
  zu übernehmen. Aufrufer muss das Ergebnis auswerten und via `t()` melden.
- **Format-Versionen** (`FORMAT_VERSION` in `config.js`): `loadJSON` nimmt alles **bis** zur
  aktuellen Nummer an und hebt es beim Laden an; abgelehnt wird nur, was **neuer** ist. Wer eine
  Nummer hochzählt, trägt die Anhebung gleich daneben ein – und denkt an `qdfimport.js`: der
  Einleser baut die Felder neu auf und muss deshalb **die aktuelle** Nummer liefern, sonst läuft
  die Migration ein zweites Mal über frische Daten.

## Stückliste (bom.js)

- `inferConnectorType` klassifiziert nach Anzahl + Lage der Arme (koplanar ⇒ `t`/`cross`,
  sonst `3way`/`4way`, …). Geprüft wird die **Ebene selbst** (Normale aus dem ersten nicht
  parallelen Paar), nicht nur die drei Achsenebenen – ein um 45° gedrehter Aufbau wie der
  Ball Cage hat sonst lauter Raumkupplungen, wo flache sitzen.
- **Kupplungen, die wir nicht setzen können** (Flexikupplung `flexi-connector3`, ihr Bolzen
  `bolt2`, Lagerkupplung `bearing-connector4`, Rohrkappe `tube-cap2`): sie kommen als
  **Anbauteile** herein (`FITTING_KINDS` mit `keepRest`), werden über `qdf` im Katalog benannt
  und gezählt, **nicht gezeichnet** (`_fittingMeshes` kennt sie nicht → `default: return []`)
  und beim Speichern Zeile für Zeile so zurückgeschrieben, wie sie in der Datei standen
  (`f.rest` hält den Rohtext hinter der Lage). An einem Punkt mit Flexi-Armen steht in der
  Datei **keine** `connector3`: der Knoten bekommt `part = "flexi"` (nur wenn dort keine
  Kupplung stand, `fromFile`), damit Anzeige und Liste „Flexikupplung" sagen statt eine
  Raumkupplung zu raten – gezählt werden die Arme als Anbauteile, der Knoten selbst liefert
  nichts (`connectorsForNode`).
- **Lochzapfenkupplung** (`hole_1`, QDF `hole-connector4`): sie sieht aus wie **„O--"** – ein Ring
  greift über den **Stutzen einer Kupplung**, quer dazu steht ihr eigener Stutzen, in dem das Rohr
  steckt; sie klemmt also nichts. Der Knoten liegt am Fuß dieses Stutzens, eine Kupplungslänge
  neben dem Würfel; `stub` ist die Rohrrichtung, die Ringachse die lokale **−X**-Achse von
  `partQuat`. Der eigene Stutzen setzt an der **Innenwand** des Rings an, und die tragende
  Kupplung bekommt in diese Richtung einen Arm-Stutzen gezeichnet, obwohl dort kein Rohr steckt
  (`tubeDirsAt` in `scene.js`). Der Import hängt das Rohr an sie um
  (beim Einlesen der Rohre gab es sie noch nicht, ihr Ende war auf die Kupplung daneben
  geschnappt), und `neighborDirs` zählt sie als belegten Arm der tragenden Kupplung.
- **Bällebad = EIN Teil:** Es ist ein **Anbauteil** (`kind: "pool2"`/`"pool-small2"`), kein
  Satz Platten – wie der Spielsack: eine Auswahl, ein Löschen, eine QDF-Zeile. Der Bezugspunkt
  ist die Oberkante der Frontwand (so steht es in der Datei), dazu `w` (Breite), `h` (Wandhöhe)
  und `d` (Tiefe, **mit Vorzeichen** – die Datei führt die Tiefe nicht, sie wird beim Import aus
  dem Kupplungsnetz abgeleitet). Wände, Boden und Wasser zeichnet `scene.js` daraus.
  Beim Ableiten der Tiefe zählen **nur die Maße, die es als Folie gibt** (`POOL_DEPTHS` in
  `qdfimport.js`): die Suche nimmt sonst die entfernteste Reihe, an der zufällig vier Ecken
  stehen, und läuft in die Konstruktion dahinter – in drei Herstellerdateien kamen so 440 und
  520 cm heraus statt 160.
  Die Folie hängt innen im Rahmen: an den vier Seiten und oben 2,5 cm eingerückt (halbe
  Rohrbreite), unten liegt sie auf. `catalog.poolLinerFor(w, d)` wählt daraus die Poolfolie XS/S/L/XXL (Maße am Katalogteil unter `pool`);
  passt nichts genau, gewinnt die flächenmäßig nächste Größe. Ältere Stände führen den Pool noch
  als fünf Platten mit `poolPart` – Import, Export und Stückliste kennen beide Formen.
- `connectorsForNode` liefert **alle** Kupplungen eines Knotens: an einem `c45`-Knoten
  Basiskupplung **plus** je Diagonale eine `diagonal`-Winkelkupplung.
- `link`-Kanten sind kein Arm und fließen nicht in die Heuristik ein; `arm`-Kanten schon.
- **Schrauben** (`computeScrews`) werden nur gerechnet: kein Teil im Modell, nichts zu setzen,
  nichts zu zeichnen, nichts im Bestand. Grundregel des Systems: an einer Kupplung hat ein Rohr
  genau EIN Loch. Deshalb wird nicht addiert, sondern **belegt** – jedes Rohr (ohne `arm`/`link`)
  bringt zwei Plätze mit (`tubeId@nodeId`), Platten (4 je Platte) und Rutschen nehmen sich welche,
  und was frei bleibt, sind die Rohrschrauben (nach Rohrfarbe). Rutschen: je Verbindung
  (`model.slideExit` trifft ein weiteres Teil) 2 konische + 2 Gegenstücke + 2 Rutschenschrauben,
  der Kettenkopf zusätzlich 2 konische + 2 Plattenschrauben; die Integralrutsche braucht keine.
  Am Einstieg sitzen sie an bestimmten Stellen: die Plattenschrauben im **waagerechten** Trägerrohr
  (je Ende eine), die konischen in den Rohren, die von dessen Kupplungen nach **oben** gehen.
  Die Katalog-Gruppe `screws` in `parts.json` führt den **Packungs**preis plus `pack`; die Liste
  rechnet anteilig (`price = Packpreis / pack`).
- **Schrauben im Bestand:** sie stehen im Bestandseditor wie alle anderen Teile (Topf
  `inventory.screws`, die Rohrschraube farbgenau). Für die Machbarkeit gilt eine Sonderregel in
  `compareInventory`: ein Bestand von **0** heißt „noch nicht gezählt", nicht „fehlt" – die Zeile
  wird trotzdem rot, das Machbarkeits-Banner bleibt aber grün (`soft: true` an der Zeile). Ab dem
  ersten eingetragenen Stück zählt der Bestand normal mit. Die Bibliothek lässt Schrauben ganz
  außen vor: ihre gespeicherten Kennzahlen (`meta.parts`) führen nur Rohre, Kupplungen, Platten
  und Verstärkungen.
- **Verstärkungen:** zu kaufen gibt es nur **ein** Teil, das Holz-Profil mit 80 cm
  (`reinforce80`); die Alu-Profile der Herstellersoftware sind nirgends mehr erhältlich, kommen
  aber weiter aus QDF-Dateien herein. Ein Profil deckt **80 cm Knotenabstand**: ein 75er-Rohr
  (Span 80) oder zwei 35er in einer Linie (40 + 40). Gesetzt wird über `model.addReinforcement()`,
  gezogen über `removeReinforcement()` – beim 35er geht der Partner mit, ein halbes Profil gibt es
  nicht. Kollineare verstärkte Rohre werden für die Stückliste per Union-Find zu **Läufen**
  verschmolzen; gezählt werden daraus ganze Profile (`Lauflänge / 80`, aufgerundet auf mindestens
  eins), nicht Rohre – sonst stünden zwei 35er als „2 x 80 cm" da. Das Anbau-Kennzeichen bleibt
  `tube.reinforced`; es gibt bewusst **kein** eigenes Profil-Objekt im Modell, damit Verschieben,
  Kopieren und der QDF-Rundlauf unverändert bleiben.

## Konventionen

- **Neues Teil:** nur Eintrag in `data/parts.json` (`connectors`/`tubes`/`panels`/`reinforcements`/
  `accessories`/`screws`).
  Dazu gehört `url` – die Seite des Teils bei quadroshop.com (gibt es das Teil nicht einzeln, die
  passende Übersichtsseite). Daraus baut die Stückliste im Bestands-Modus den 🛈-Link.
  Gerade Rohre mit `buildable:true` + `length_cm` und Platten mit `buildable:true` + `w`/`h`
  erscheinen automatisch als Button – **keine Code-Änderung**. Geometrie unter `geometry`.
  Preisänderungen bitte mit Quelle im Commit (z. B. quadroshop.com, Stand).
- **Farben:** ausschließlich als CSS-Variable im `:root`-Block von `style.css`, im Rest der Datei
  nur `var(...)`. Ein fester Wert irgendwo unten bleibt im **Dunkelmodus** hell stehen. Ausgenommen
  sind Farben ohne Bezug zum Schema: Produktfarben (Farbrad) und Kacheln, die immer dunkel sind
  (Statuszeile, Beschriftungen über der Szene). Wer eine Rolle braucht, die es noch nicht gibt,
  legt eine Variable an und trägt sie in **beiden** Blöcken ein.
- **Neues über das QDF-Format** gehört in `QDF-FORMAT.md` – dort steht jedes Element mit allen
  Feldern und der Angabe, wie sicher wir uns sind (sicher / vermutet / unbekannt). Die
  Fundstellen-Kommentare im Code bleiben, aber die Beschreibung des Formats hat genau einen Ort;
  wer ein Feld entschlüsselt, trägt es dort ein und streicht es aus „Was wir nicht wissen".
- **Zwei Raster, nicht eins:** `SNAP_STEP` (5 cm, `builder.js`) ist das feine Raster der Geometrie
  – Drehachse einer Auswahl, Rohr in einer Klemme. `builder.moveStep` ist die vom Nutzer
  eingestellte Schrittweite fürs **Verschieben** (Pfeiltasten, Ziehen, Einfügen; 5/10/20/40/80 cm,
  Voreinstellung 20). Die beiden nicht vermischen: mit 80 cm als Drehachsen-Raster springt eine
  Auswahl beim Drehen quer durchs Bild.
- **Three.js liegt gevendort in `web/vendor/three/` (r185) und besteht seit r185 aus ZWEI Dateien:**
  `three.module.js` lädt `three.core.js` nach. Beim nächsten Update beide tauschen **und** beide im
  Vorrat des Service Workers führen – fehlt die Core-Datei, startet die App ohne Netz nicht mehr.
  `OrbitControls.js` gehört zur selben Version (es erbt seit r169 von `Controls` aus dem Kern).
- **Die Drehung einer Platte steckt in ihrer LAGE, nicht in einem eigenen Feld.** Die
  Hersteller-Software kennt vier Stellungen (0/90/180/270°), sie unterscheiden sich nur in der
  Rolllage um die Plattennormale – Mitte, Maße und Material bleiben gleich. Beim Einlesen ergibt
  sich daraus von selbst das richtige Rohrpaar (`findPanelCorners` ordnet die Ecken nach den
  lokalen Achsen), beim Schreiben dreht `rectLine` die lokale X-Achse auf die andere Kante, wenn
  `p.turned` gesetzt ist. `turnPanel` dreht zusätzlich die gespeicherte Datei-Lage mit – sonst
  schriebe der Export für eine eingelesene Platte weiter die alte Rolllage.
- **Quaternionen aus der Datei sind NICHT normiert** (Werte quadriert und mit 4 skaliert).
  `xAxisOf`/`yAxisOf`/`zAxisOf` normieren deshalb selbst: mit einer zu langen Quaternion kommt
  nicht etwa eine zu lange Achse heraus, sondern eine ganz andere Richtung – daran sind schon die
  Arme der Lochzapfenkupplung und die Plattendrehung gescheitert.
- **Touch im Cursor-Modus:** Strg/Shift gibt es dort nicht, deshalb übernimmt das **Halten**
  (`LONG_PRESS_MS`, 450 ms) beide Aufgaben – auf einem Teil schaltet es dieses zur Auswahl hinzu,
  im Leeren beginnt es das Auswahl-Rechteck (danach greift derselbe Ablauf wie bei Strg + Ziehen).
  Damit das Halten überhaupt ankommt, beginnt das **Verschieben** einer Auswahl per Finger erst
  bei der ersten Bewegung (`_dragKandidat`) – vorher startete der Zug schon beim Aufsetzen.
- **`stock: false` im Katalog** heisst: das Teil bleibt, taucht aber im Bestand nicht auf – weil kein
  Modell es je anfordert. Das haben die sieben gelochten Rohre (die QDF-Datei führt für ein Rohr nur
  eine Länge, Löcher und Winkel kann sie nicht ausdrücken) und das offene Verbinderende (ein Vermerk
  an einer Kupplung, kein Bauteil). Gezeichnet, gezählt und geschrieben werden sie weiterhin.
- **Neue UI-Texte:** immer in **beide** Dictionaries (`de` und `en`) in `i18n.js`, dann `t('key')`
  bzw. `data-i18n`/`data-i18n-title`/`data-i18n-placeholder`/`data-i18n-aria` im HTML. Nie Strings
  in `ui.js` hardcoden.
- **Sofort umschalten, nicht erst beim Neuladen:** `applyTranslations()` erwischt nur, was im HTML
  steht. Alles, was `ui.js` selbst baut, muss der Sprachwechsel-Handler (`langBtn`) **neu
  zeichnen** – sonst bleibt es in der alten Sprache stehen, bis es zufällig neu gebaut wird.
  Besonders leicht zu übersehen sind `title`-Attribute, die nur einmal beim Anlegen gesetzt
  werden (so blieben die Tooltips der Anbauteil-Gruppen und der Tab-Schließen-Knöpfe stehen).
  Prüfen lässt sich das im Browser: alle sichtbaren Texte und Attribute einsammeln, Sprache
  umschalten, noch einmal einsammeln – was gleich bleibt und Buchstaben enthält, ist verdächtig
  (Dateinamen, Tab-Namen und „QUADRO" sind die erlaubten Ausnahmen).
- **Statuszeile (unten links):** `setStatusHint()` setzt den dauerhaften Hinweis zum laufenden
  Werkzeug (aus `setMode`), `flash()` legt eine kurze Rückmeldung für 3,5 s darüber und stellt
  danach den Hinweis wieder her. Nichts sonst schreibt in `#status`.
- **Rückfragen:** nie `alert`/`confirm`/`prompt`. In `ui.js` stehen `dialog()` und die
  Kurzformen `askConfirm()`, `askInput()`, `showMessage()`; sie füllen die Karte
  `#dlg-overlay` (Enter = erster Knopf, Escape/Klick daneben = Abbruch).
- **45°-Winkelkupplung:** ein eigenes Teil in der Gruppe „Verbindungen" (`C45_ENTRY` in `ui.js`),
  Modus `c45` im Builder. `_buildC45Handles()` bietet an jedem **freien Arm** einer Kupplung einen
  Punkt an (**grün**, wie die übrigen Bau-Punkte), `model.addC45Adapter()` setzt Hülse +
  Adapterkörper (ohne Rohr), ein weiterer Klick auf die gesetzte Kupplung dreht sie über
  `model.rotateC45()` um 90° um ihre Hülsenachse – aber nur, **solange kein Rohr daran steckt**.
  Welche Schräge zu einem Arm gehört, rechnet `_diagSleeveAxis()` wie eh und je aus; der 45°-Arm
  knickt dabei **zurück** über die Kupplung (Achsanteil entgegen der Hülse) – wer das verwechselt,
  zeichnet sie gespiegelt. Das Rohr kommt danach im Bau-Modus an den Adapterkörper – der bietet genau
  seine eigene Schräge an (`_c45ArmDir`). Einen Schalter „Schräg" gibt es nicht mehr.
- **Neue Bau-Richtung/Logik:** `config.js` + `builder.js` (+ ggf. `scene.js`).
- **Tastatur:** zentral in `ui.js` (`keydown`). Pfeiltasten sind kamera-relativ über
  `scene.getHorizontalAxes()`. **Strg/Cmd+W ist nicht abfangbar** – Browser schließen damit ihren
  eigenen Tab, bevor die Seite das Ereignis sieht (auch als installierte PWA); ein Entwurf-Tab geht
  deshalb mit **Alt+W** oder Mittelklick zu.
- **Code-Stil:** ES2022+, Kommentare auf Deutsch **mit Umlauten** („Änderung", „Löschen", „Körper"),
  Bezeichner auf Englisch. Das gilt auch für Namen und Notizen in `data/parts.json`.
  Keine neuen externen Abhängigkeiten.
- Nur ändern, was gefragt ist – kein Over-Engineering.

## Fallstricke

- **Die Kamera gehört zum FENSTER, nicht zur Sitzung.** Die Sitzung (offene Tabs samt Ansicht)
  liegt einmal in der Datenbank – mehrere Browser-Fenster überschreiben sie gegenseitig, und beim
  Neuladen bekam man die Ansicht eines anderen Fensters. Der Kamerastand liegt deshalb zusätzlich
  im `sessionStorage` (`quadro.camview.v1`, je Tab-Kennung), den jedes Fenster für sich hat; beim
  Start gewinnt er. `quadro.camera.v1` in `localStorage` bleibt als Rückfall für ein Fenster ohne
  eigenen Stand. Gesichert wird entprellt **und** sofort bei `visibilitychange`/`pagehide` –
  sonst verschluckten die 400/600 ms den letzten Stand.
- `catalog.js` lädt `../data/parts.json` relativ – die App muss unter `/web/` ausgeliefert werden.
- **Die Zoomgrenze gehört nicht ans Zeichnen.** `_applyZoomLimits(model)` läuft auch dann, wenn
  `renderModel` wegen der noch ladenden Modelldateien früh aussteigt: sonst gilt weiter die Grenze
  für ein leeres Modell (600 cm), und der nächste `_applyZoomLimits()` – Fenstergröße, Projektion –
  zieht eine weiter draußen stehende Kamera heran. Genau daran starb die gerade wiederhergestellte
  Ansicht beim Neuladen.
- **Beim Start wird gewartet, nicht ersetzt:** solange eine gebrauchte Modelldatei unterwegs ist
  (`MESH_FIELDS`-Feld auf `null`), zeichnet `renderModel` das Modell **gar nicht** und lässt einen
  kleinen Kreisel laufen (`_setLoading`, `.scene-spinner`). Sonst stünden nach jedem Neuladen erst
  die selbst gezeichneten Ersatzformen da und wechselten kurz darauf. Scheitert eine Datei
  endgültig, steht im Feld `false` – dann geht es mit den Ersatzformen weiter, sonst liefe der
  Kreisel ewig.
- **Abgegriffene Originalmodelle** (`data/models/*.json`, erzeugt aus `tmp/extracted/models/` mit
  `tools/obj2mesh.py`): Kupplungen, das Bogenrohr, Rutschen, Dächer und die Anbauteile zeichnet
  die Szene damit statt aus Primitiven – auf **allen** Qualitätsstufen, damit ein Teil überall
  gleich aussieht. Vier Dateien, je eine Gruppe: `connectors`, `tubes`, `slides`, `fittings`.
  Was dabei zählt:
  - **Zwei Auflösungen je Gruppe.** Neben `foo.json` steht `foo-fine.json` aus den
    `*_fine.obj`-Abgriffen; die Stufe **„hoch"** (`fine: true` in `QUALITY`) legt sie über die
    grobe Fassung. Die feine Datei führt **nur**, wovon es einen feinen Abgriff gibt – für Dach,
    Integralrutsche und die Platten bleibt es beim groben Modell, und fehlt die Datei ganz, fällt
    `meshes.js` still darauf zurück. Beim Stufenwechsel wirft `_dropMeshes()` die Felder **und**
    die daraus gebauten Geometrien weg; beide Auflösungen gleichzeitig zu halten wäre bei den
    Rutschen der größte Posten der Szene. Wer dort ein Feld ergänzt, trägt es in `MESH_FIELDS`
    ein, sonst bleibt es beim Wechsel auf der alten Auflösung stehen. Die feinen Dateien stehen
    **nicht** im Vorrat des Service Workers (dreifache Größe für eine Stufe, die die meisten nie
    wählen) – sie landen über den Fetch-Zweig im Cache.
  - **Die Armmaske kommt aus den Rohren, die wirklich anstecken** (`tubeDirsAt`), nicht aus
    `variant2` der Datei. Am Bestand gemessen führt `variant2` an den allermeisten Knoten mehr
    Arme als Rohre – gezeichnet stünden dort überall Stutzen ins Leere.
  - `maskTable()` in `scene.js` legt jede Maske über die **24 Würfeldrehungen** auf eines der
    acht Modelle. Passt nichts (schiefe Richtung > 20°, zwei Teile auf einem Arm, weniger als
    zwei Arme), zeichnet der alte Pfad Würfel plus Stutzen. Am größten Beispielmodell greift
    der Rückfall noch an 2 von 239 Kupplungen.
  - **Das Bogenrohr kommt ebenfalls aus dem Mitschnitt** (`data/models/tubes.json`,
    `_bowMeshFor()`). Das ist keine Kosmetik: der selbst gezeichnete Bogen bog schon an der
    Kupplungsfläche ein und ließ dem geraden 5-cm-Arm nur 0,4 mm Luft – weniger, als die
    Facettierung des Rohrs frisst (0,47 mm bei 16 Segmenten), der Arm stieß durch die Wand.
    Der abgegriffene Bogen läuft an beiden Enden erst 25 mm **gerade** in der Kupplungsachse,
    dort liegt seine Wand bei 25 mm von der Achse und der Arm (r 21) steckt sauber darin.
    Seine Lage baut `_bowMeshFor()` aus Knoten und `bowCenter` (lokales +X = Tangente am
    Anfang, +Y = zum Kreismittelpunkt), also auch für im Editor gesetzte Bögen. Passt der
    Bogen nicht zum Modell (Halbmesser ≠ 40 cm, kein Viertelkreis – etwa die 135°-Winkelrohre),
    zeichnet die Szene weiter ihren eigenen Schlauch; **dort** kann der Kupplungsarm wieder
    durch die Wand stoßen.
  - **Die Raumkupplung 3-armig trägt Maske 21** (+X, +Y, +Z – drei zueinander senkrechte Arme).
    Maske 13 wäre +X, +Y, −Y und damit wieder ein ebenes T wie Maske 7; wer die Modelle neu
    abgreift, muss die Maske richtig wählen.
  - **Beide Seiten rendern bleibt Pflicht.** Der Umlaufsinn ist in den Modelldateien zwar
    gerichtet, aber die Rutschbahn hat keine Wandstärke – sie ist ein einzelner Flächenzug.
    Mit `FrontSide` fehlt von einer Seite die halbe Rutsche.
  - **Anbauteile** sitzen alle auf ihrer Lage aus der Datei, `_placeFitting()` genügt. Zwei
    Ausnahmen: der **Spielsack** – der Import rückt seinen Punkt um `BAG_OFFSET` (20 cm) auf die
    Feldmitte vor, das Modell erwartet den Punkt aus der Datei, also wieder zurück; und das
    **Bällebad**, das seinen Wasserquader behält (den zeichnet die Herstellersoftware nicht).
  - **Teile mit Maßen in der Datei** führen ihre Kantenmaße als QDF-Felder 3 und 5, ein Modell
    mit EINER Größe deckt sie nicht ab. Abgegriffen ist inzwischen jedes Maß aus Korpus und
    Katalog, benannt `<element>_<Feld3>x<Feld5>.obj`: `panel2` in neun Größen (350×350, 350×150,
    150×350, 750×750, 750×150, 250×250, 650×1150, 1150×350, 1150×1550), `textil2` in vier
    (350×750, 550×750, 590×750, 600×750), `alu2` in beiden Längen (`alu2.obj` = 800 mm,
    `alu2_600.obj` = 600 mm). Die Platte ist dabei **reine Skalierung** – immer 22 Dreiecke,
    Kiste = Maß + 50 mm, Dicke 47,1 mm; das Alu-Profil dagegen nicht (800 mm hat 268, 600 mm
    nur 220 Dreiecke).
  - **Die Lochplatte gibt es in der Herstellersoftware nicht.** Die Datei unterscheidet sie
    nicht (kein Feld dafür), und geprüft ist auch, dass es nicht an der Darstellung liegt: alle
    neun Platten-Materialien liefern dieselben 22 Dreiecke, und die einzigen `.bmp`-Zeichenketten
    der Binärdatei gehören zu einem Datei-Dialog, nicht zu einer eingebauten Textur.
    `hole_panel_40x40.obj` ist deshalb ein **Nachbau** (`tools/make_hole_panel.py`): alles außer
    der Deckfläche stammt unverändert aus dem Mitschnitt, die Deckfläche ist mit 3 × 3 Löchern
    neu vernetzt. Raster 120 mm, Durchmesser 90 mm, Wandtiefe 16 mm sind aus dem Herstellerbild
    **geschätzt** – wer die echten Maße hat, erzeugt die Datei mit drei Zahlen neu.
  - **Flächen** (`data/models/surfaces.json`) gibt es je Maßpaar, weil die Datei die Kantenmaße
    führt. Gebraucht werden nur die, die es wirklich gibt – über 233 Herstellerdateien gezählt:
    Platten **40x40** (2792×), **40x20** (106×) und **30x30** (16×), Tücher **80x40** (63×),
    **80x65** (11×), **80x64** (7×) und **80x60** (1×). Andere Größen führt der Katalog nicht
    mehr als setzbar. Die halbe Platte liegt in einer Drehung vor, quer dreht
    `_surfaceMeshFor()` das Achsenkreuz. Passt kein Maß genau (gedrehte Aufbauten mit 39 statt
    40 cm Spannweite), zeichnet der alte Pfad. Die **Lochplatte** hat keines: die Software
    zeichnet ihre Löcher nicht, unsere Fassung schon.
  - **Das Verstärkungsprofil liegt NEBEN dem Rohr**, mit Pfeilen darauf – so zeigt es die
    Herstellersoftware, und die Pfeile stecken im Modell. Gezeichnet werden ganze **Läufe**, nicht
    Einzelrohre: `reinforcementProfiles()` steht dafür in `qdfexport.js` und wird von `scene.js`
    mitbenutzt, damit Bild und Datei nicht auseinanderlaufen. Abgegriffen sind 800 und 600 mm;
    ein Lauf mit krummer Länge (gedrehte Aufbauten) behält den gezeichneten Innenstab, `aluGedeckt`
    hält die schon versorgten Rohre fest. Die **Rollachse** ist frei wählbar – im Bestand kommen
    neun verschiedene vor, eine Regel gibt es dort nicht; genommen wird die, die am ehesten nach
    oben zeigt.
  - **Der Punkt einer Klemme liegt im Loch des gehaltenen Rohrs**, nicht zwischen ihren beiden
    Löchern. So steht er in der Datei (Test.qdf: Rohr auf der Y-Achse, `clamp2` auf 0/340/0),
    und genau dort hat das abgegriffene Modell seinen Nullpunkt – die alte Mitte zeichnete es
    2,5 cm daneben. Wohin das **zweite** Loch zeigt, steckt allein in der Drehung: beim
    Doppelrohrverbinder liegt es 5,0 cm in lokal **−Z**, bei der Rohrklammer 5,5 cm in lokal
    **+Y** (an den Modellen gemessen). Import und Export rechnen das ineinander um
    (`clampQuat` in `qdfexport.js`), Speicherstände von vorher schiebt die Migration auf
    **Format 2** zurecht.
  - **Teile mit FESTER Farbe** stehen in `fixedFittingColor()` (`model.js`): die **Poolfolie**
    gibt es nur in **Blau** (so steht sie auch in allen 43 Vorkommen des Bestands, Material 8),
    Radlager, Schwimmrad und Rohrkappe nur in Schwarz. `scene.js`, `qdfexport.js` und
    `setColorOf` fragen dort nach – die Baufarbe gilt für sie nicht.
  - **Radlager (`bearing2`), Schwimmrad (`floating-wheel2`) und Rohrkappe (`tube-cap2`) gibt es
    nur in Schwarz** – weder die Baufarbe noch die aus der Datei färbt sie um (`BLACK_FITTINGS`
    in `model.js`; `scene.js`, `qdfexport.js` und `setColorOf` holen sich die Liste von dort). Radlager und Schwimmrad tragen in den
    Herstellerdateien durchgehend Material 1 (125 bzw. 76 Vorkommen); die neun Rohrkappen des
    Bestands stehen dort zwar auf Rot, das Teil gibt es aber nur schwarz. Das **Multirad**
    dagegen kommt in Farben (Material 6–9).
  - **Rohrkappe und offenes Verbinderende sind zwei Teile**, nicht eins: `tube-cap2` ist 24 mm
    lang und an einem Ende geschlossen (Katalog `tube_cap`), `open-connector2` eine 50 mm lange,
    beidseitig offene Hülse auf einem Stutzen (Katalog `open_end`). Das offene Verbinderende
    **erzwingt** diesen Stutzen: ohne Rohr wird dort sonst keiner gezeichnet und keiner
    gerechnet. Dafür steht es in `ARM_FITTINGS` (`scene.js` **und** `bom.js`), und der Export
    setzt sein Bit in der Arm-Maske der Kupplung – in allen 67 Vorkommen des Bestands steht es
    dort auch. Die **Rohrkappe** steckt dagegen über dem Rohrende und **ersetzt** dort die
    einarmige Kupplung (`hasWheelCap`, wie die Radkappe): ihr Modell liegt als einziges auf der
    **Minus**-X-Seite seines Nullpunkts, sitzt vom Knoten aus also 2,1 bis 4,5 cm nach INNEN und
    schiebt sich damit 2 cm über das Rohr. Nicht drehen – gedreht stünde sie frei in der Luft
    vor dem Rohrende. (Die Herstellerdateien führen an derselben Stelle zusätzlich eine
    `connector3` – Spieltisch: beide auf −800/−50/−800; wir zeichnen und zählen dort nur die
    Kappe.) Ihre Ankerpunkte kommen aus `_wheelCapMounts` und brauchen wie alle Punkte an einer
    Kupplung ein `handle` weiter außen, sonst steckt der grüne Punkt im Würfel.
  - **Die Lochzapfenkupplung gibt es dreifach** (`hole_1`, `hole_2`, `hole_t`) und sie ist ein
    **Knoten**, kein Anbauteil: sie steckt mit ihrem Loch auf einem freien Stutzen einer
    Kupplung, ihre eigenen ein bis drei Arme tragen dann Rohre wie die einer Kupplung. Welche
    Arme das sind, sagt die Maske aus der Datei (`partMask`, Bits 0x01/0x02 = das Loch): 11 = −Y,
    15 = ±Y, 59 = −Y ±Z; 31 ist dieselbe dreiarmige um 90° gedreht. **Nicht die Bits zählen** –
    Maske 11 hat drei Bits und ist die EINARMIGE. Ihre Lage steht in `partQuat` (lokal −X zeigt
    zur tragenden Kupplung, die 5 cm entfernt sitzt), die Arme rechnet `holeArmDirs()` daraus –
    dort **normieren**, die Lage aus der Datei hat nicht Länge 1. Gesetzt wird über
    `holeArmMounts()`/`addHoleClamp()`, ein weiterer Klick dreht sie um 90° um die Lochachse
    (`turnHoleClamp`, gesperrt sobald ein Rohr an einem Arm hängt). Ihr Modell liegt bei den
    **Anbauteilen** (`hole-connector4_<maske>`), obwohl sie ein Knoten ist – deshalb steht sie
    mit in der Bedingung, die `fittings.json` nachlädt. Der Stutzen, auf dem sie steckt, ist
    **belegt** (`holeClampDirsAt`): dort geht kein Rohr und kein weiteres Teil mehr hin – nur die
    **Multirad-Arretierung** (`onClamp: true` in `FITTING_MOUNTS`), die sie festhält; so steht
    sie auch in den Herstellerdateien direkt daneben.
  - **Die Flexikupplung ist ein KNOTEN aus drei Teilen**: der Bolzen (`bolt2`, 15 cm, drei
    Segmente zu je 5 cm entlang seiner lokalen +X) und bis zu zwei Scharniere
    (`flexi-connector3`, Kranz um den Bolzen, eigener Stutzen nach lokal −Y). Am Katalogteil
    `flexi_hinge` hängt deshalb das `qdf`, nicht am Teil `flexi` – sonst zählte die Stückliste
    jedes Gelenk als zwei ganze Flexikupplungen. Im Modell trägt der Knoten `part =
    "flexi_bolt"`, seine Lage steht in `partQuat` (lokal +X = Bolzenachse, vom Rohr weg) und
    die Stellungen der Scharniere als Winkel in `hinges` (0 = lokal −Y). Gesetzt wird über
    `boltMounts()`/`addBolt()` – nur auf eine **Dummy-Kupplung** (Rohrende mit genau einem
    Rohr), dort ersetzt der Bolzen die Kupplung – und `hingeMounts()`/`addHinge()`. Ein Klick
    auf ein Scharnier dreht es um 45° weiter (`turnHinge`); die Kränze rasten zwar in 45°-
    Schritten, zwei Scharniere dürfen aber nie **näher als 90°** zusammenstehen
    (`HINGE_MIN_GAP`) – dafür sind ihre Riemen zu breit, und im Bestand stehen sie an allen 83
    Gelenken 135° auseinander. Verbotene Rastungen überspringt der Klick. Ein Arm mit Rohr
    dreht sich nicht mehr. Das **zweite Scharnier zeichnet `scene.js` um seine Armachse
    gewendet** (180°, von vorn auf den Stutzen gesehen), sonst liegen die Riemen beider
    übereinander; die **Datei kennt diese Wendung nicht** (beide Scharniere tragen dort
    dieselbe X-Richtung), sie gehört deshalb nicht in den Export. Die
    Anschlussrichtungen (`boltArmDirs`) sind seine beiden Stutzen plus je Scharnier dessen
    Arm – der Builder holt sie über `_armDirsOf`, damit Ankerpunkte und Belegung stimmen.
    Beim Import wird das Gelenk zusammengefasst, sobald an seinem Punkt ein Knoten steht
    (63 der 84 Bolzen des Bestands); die übrigen bleiben Anbauteile mit ihrem Rohtext und
    gehen unverändert wieder hinaus. Wo der Punkt liegt, sagt **Feld 4 der bolt2-Zeile**
    (1 = mittig, 0 = 50 mm entlang −X) – siehe QDF-FORMAT.md.
  - **Die Lagerkupplung** (`bearing-connector4`, Katalog `bearing`) klemmt um ein Rohr und
    **trägt eine Kupplung**. Die steht in der Datei als eigene `connector3`, 10 cm entgegen der
    +X-Achse der Klemme (gemessen: alle 47 eindeutigen Fälle). Ein eigener Durchlauf im Import
    hängt sie zusammen (`node.bearingOn`, `node.stub`), sonst stand die Kupplung als nackter
    Würfel ohne Stutzen neben dem Rohr. **Gesetzt** wird sie in beiden Reihenfolgen: ans Rohr,
    dann erscheint die Kupplung außen (`addTubeClamp`), oder an einen freien Arm einer Kupplung,
    dann klemmt später ein Rohr darin (`addBearingAtArm`). In beiden Fällen entsteht dieselbe
    Form wie beim Laden – ein **Anbauteil** plus ein **gewöhnlicher Knoten**, nie ein Knoten,
    der beides ist. Ihre Lage braucht **zwei** Achsen: lokales +X zeigt von der getragenen
    Kupplung weg, und das geklemmte Rohr läuft entlang des lokalen **+Y** (gemessen an allen 86
    eindeutigen Vorkommen). Nur +X festzulegen lässt die Rolle offen und die Klemme steht quer
    zum Rohr statt darum – dafür gibt es `bearingQuat()`. Steckt noch kein Rohr darin, bietet
    `bearingOpenings()` einen Ankerpunkt **im Maul** an, genau auf der Achse, auf der das Rohr
    durchläuft – dieselbe Mechanik wie die freie Öffnung einer Rohrklammer (`clampOpening` →
    `_placeSecondTube`). Der vom Teil belegte Arm der tragenden Kupplung wird dabei gesperrt,
    sonst liefe das Rohr längs durch die Klemme statt quer hindurch. Ein Klick auf die Klemme
    dreht das Maul um 90 Grad weiter (`turnBearingMouth`), solange nichts darin steckt. Der Stutzen zur Klemme zählt in der Stückliste als Arm (`neighborDirs` in
    `bom.js`), sonst stünde dort eine Kupplung mit einem Arm zu wenig.
    Und `bearing2` ist **nicht** dieses Teil: das ist das Radlager, das auf einer Kupplung sitzt
    (124 von 125 Vorkommen auf einer `connector3`), während die Lagerkupplung am Rohr sitzt
    (101 von 101 **nicht** auf einer Kupplung).
  - **Die Winkelkupplung hat eine EIGENE Lage**, nicht die des Würfels: der Würfel ist
    drehsymmetrisch, sie nicht. An **559 von 726** Vorkommen im Bestand tragen `connector3` und
    `connector45_2` an derselben Stelle verschiedene Quaternionen. Der Import merkt sie als
    `node.c45quat`, `_c45Placement()` setzt das Modell damit, und der Export schreibt sie
    zurück – ohne das zeigt jede Winkelkupplung in dieselbe Richtung, und ein Rundlauf verdreht
    sie. Fehlt sie (im Editor gesetzt), wird sie aus Hülsenachse und Armrichtung gebaut.
  - **Ohne Modell und warum** – wer eines nachziehen will, muss vorher genau das klären:
    `lattice2` wird zwar anstandslos gelesen, aber von der Software **nie gezeichnet**
    (auch nicht im Herstellermodell, in dem es vorkommt); `display2` ist nur in 350×350
    abgegriffen (zwei Dreiecke, flach – skalieren genügt); `flexi-connector3` steht **zweimal je
    Gelenk** in der Datei und liegt auf einem Knoten, den die App schon als Kupplung zeichnet
    (`part = "flexi"`) – das Modell käme doppelt und über den Würfel.
  - **`clip2` ist abgegriffen**, brauchte aber einen Trick: in Feld 4 muss **0** stehen. Mit der
    `3` der einzigen Korpuszeile lädt die Datei und die Software zeichnet nichts (siehe
    `QDF-FORMAT.md` §5.3).
  Geladen wird erst, wenn ein Modell die Teile enthält, und danach zeichnet `onMeshesReady()`
  (in `main.js` auf `builder.refresh()`) einmal neu.
- **Kantenglättung je Qualitätsstufe:** `antialias` schaltet die MSAA des Browsers – die kennt nur
  an oder aus. Stärker wird es nur über mehr Bildpunkte, dafür steht `ss` in der `QUALITY`-Tabelle:
  das Bild wird um diesen Faktor größer gerechnet und beim Anzeigen verkleinert (Supersampling).
  Heute: niedrig ohne MSAA, mittel mit, hoch mit MSAA **und** `ss: 1.5` – gut die doppelte
  Punktzahl, was auch die groben Kanten der abgegriffenen Modelle glättet. `MAX_PIXEL_RATIO`
  deckelt das Ganze, sonst rechnete ein Telefon mit dreifach feinem Bildschirm neunfach.
  Ein Wechsel, der nur `ss` ändert, braucht **keinen** neuen Renderer – `setPixelRatio` plus
  `setSize`, sonst behält der Puffer seine alte Größe und das Bild verzerrt.
- **Bau-Richtungen folgen der Kupplung, nicht der Welt.** `_armDirsOf()` in `builder.js` nimmt
  die sechs Würfelachsen aus `node.quat` – damit baut eine um 22,5° gedrehte Kupplung ihr Rohr
  auch um 22,5° gedreht, und `extend()` gibt die Lage an den neuen Knoten weiter, sonst knickte
  das nächste Rohr wieder auf die Weltachsen zurück. Das ältere `node.armDirs` aus dem Import ist
  nur noch Rückfall: es wurde beim Einlesen mit `nearestNamedDir` auf die nächste **benannte**
  Richtung gerundet und konnte deshalb nur 0° und 45°. `_occupiedDirs()` prüft gegen dieselbe
  Liste – wer die eine ändert, muss die andere mitziehen.
- **Ansicht zurücksetzen passt ein:** `scene.resetCamera(model)` behält immer den Blickwinkel der
  Vorgabe (`_defaultCam`), rückt aber Bildmitte und Abstand so, dass die Kiste um alle Teile ins
  Bild passt. Gerechnet wird mit den **acht Ecken** (eine Kugel um die Kiste ließe flache Modelle
  nur halb so groß erscheinen): je Ecke sagen Querabstand und Tiefe, wie weit die Kamera zurück
  muss. Ohne Modell oder bei leerem Modell gelten die alten festen Werte. Der orthografische
  Ausschnitt folgt automatisch, weil `_updateOrthoFrustum()` ihn aus Abstand und Öffnungswinkel
  ableitet. Aufrufer geben das Modell mit – ein **gespeicherter** Kamerastand (Tab-Wechsel) wird
  weiterhin über `restoreCameraState` gesetzt und nicht überschrieben.
- **Orthografisch anklicken:** Die orthografische Kamera zeichnet mit `near = -100000` auch,
  was **hinter** ihrer Ebene liegt (sonst schnitte das Drehen Teile weg). Der Auswahlstrahl von
  `Raycaster.setFromCamera` beginnt dort aber genau in der Kameraebene und trifft nur nach
  vorn – `scene._setMouse()` zieht seinen Ursprung deshalb um `camera.near` zurück. Ohne das
  waren Teile sichtbar, aber nicht wählbar, und erst ein Wechsel der Projektion half.
- **Rutschen im Aufbauplan:** Ein Rutschenteil gehört nicht in die Ebene, auf der es *endet*,
  sondern in den Schritt, der seinen **Einstieg** baut. `buildplan.slideChainHeads()` fasst dafür
  jede Kette zusammen (Ausgang eines Teils über `model.slideExit()` → dort sitzt das nächste) und
  ordnet alle Teile dem obersten zu; dessen Anker ist `hook` (im Editor gesetzt) bzw. bei
  importierten Rutschen ihr Bezugspunkt, der am oberen Ende liegt. Ohne das landete der Auslauf
  zwei Schritte vor dem Körper, an dem er hängt. Das **Dach** (`roof2`) hat keinen Ausgang und
  bleibt auf seiner eigenen Höhe.
- **Durchscheinendes im Aufbaumodus:** Alle Bauteile haengen gebuendelt als `InstancedMesh` mit
  **Einheitsmatrix im Ursprung** (die Lage steckt in den Instanz-Matrizen). Three sortiert
  durchscheinende Objekte nach der Weltposition des OBJEKTS – die ist hier fuer alle gleich, also
  gibt es **keine** Tiefensortierung, weder zwischen den Stapeln noch innerhalb eines Stapels.
  Folgen: beim Drehen kippt, was ueber was liegt; ohne `depthWrite` blendet jede Lage dahinter
  noch einmal auf (das Erledigte wurde mit jedem Schritt dichter); mit `depthWrite` streiten
  Stutzen und Rohr an ihrer Nahtstelle um Bildpunkte. Deshalb ist im Aufbaumodus alles Erledigte
  **deckend** und in EINEM Grauton (`_fadedMaterial()` kennt keine Bauteilfarbe mehr);
  durchscheinend bleibt nur der aktuelle Schritt, der sich mit sich selbst kaum ueberlappt. Wer
  die Farben zurueckholen will, muss die durchscheinenden Teile einzeln zeichnen – gemessen:
  33 statt ~1740 Draw-Calls bei einem Modell mit 975 Teilen.
- **Was vor dem ersten Bild stehen muss, steht in `index.html`:** zwei kurze Skripte, weil
  `main.js` erst auf den Katalog wartet – das **Farbschema** im `<head>` (`data-theme` am `<html>`)
  und die **Geräteform** direkt nach `<body>` (`mobile-portrait`, `sidebar-overlay`, dieselben
  Medienabfragen wie `applyLayout()`). Ohne sie blitzte erst die helle, dann die
  Schreibtisch-Fassung auf. Beide Werte pflegt danach `ui.js` weiter.
- **Bällebad als Bausatz:** `model.poolFragment(spec, {color, linerColor, tubeFor})` liefert
  Rahmen **und** Folie als **Fragment** – dasselbe Format, das `extractSelection` beim Kopieren
  erzeugt. `builder.startPool(linerId)` reicht es an `startPaste()` weiter; damit gelten
  Rasterung, Kollisionsprüfung, „nur in der Ebene" und Escape ohne eine Zeile eigenen Codes.
  `color` darf dabei eine **Funktion** sein – der Rahmen bekommt Rohr für Rohr eine zufällige
  Farbe (die Baufarbe gilt für ihn nicht), die Folie ist immer blau.
  Die vier Größen stehen in `POOL_SETS` (Herstellermaß: Innenmaß der Folie = Rahmen + 2,5 cm):
  XS 80×80, S 80×120, L 120×160, XXL 120×240, Wandhöhe 20 bzw. 40. In der **Länge** zählt jedes 75er, das hineingeht (S = 75 + 35, L = 2 x 75, XXL = 3 x 75), und
  die beiden Längsseiten laufen **versetzt** – 75 + 35 links, 35 + 75 rechts,
  damit die Stöße nicht gegenüberliegen. Quer dazu stehen immer 35er – auch auf der
  80 cm breiten Seite, die rechnerisch in ein 75er passen würde (Beispiel des Herstellers
  „Pool groß": Langseite 2 x 75, Breitseite 3 x 35). Den Katalog kennt
  `model.js` nicht – das Rohr zu einer Spannweite liefert der Aufrufer über `tubeFor()`.
- **Das QDF-Format kennt nur ZWEI Becken:** `pool-small2` (80 × 120 × 20) und `pool2`
  (120 × 160 × 40) – die Maße stehen nicht in der Datei, sie stecken im Modell. Die Tiefe
  leitet der Import aus dem Rahmen ab, deshalb lassen sich XS (80 × 80) und XXL (120 × 240)
  trotzdem schreiben und wieder einlesen; die Folie in der Stückliste stimmt in allen vier
  Fällen. Zwei Fallstricke: der Nullpunkt des **kleinen** Beckens liegt **20 cm neben der
  Mitte** seiner Frontwand (abgegriffenes Modell: −22,5 bis +62,5 cm in lokal X) – Import und
  Export rechnen das um, aber nur für die echten 80er, denn der 40 cm breite Rahmen der alten
  XS-Fassung hat seinen Punkt mittig. Und das abgegriffene Modell hat **eine feste Größe**:
  passt sie nicht zu `w`/`d`, zeichnet `scene.js` das Becken wieder aus Wänden und Boden.
  Denselben 20-cm-Versatz braucht auch das **Zeichnen** des abgegriffenen Modells – ohne ihn
  stand das kleine Becken neben seinem Rahmen.
- **Offene Menüs wandern mit der Maus:** Jeder Knopf, der ein Popup aufklappt, trägt
  `data-popup="1"` (Helfer `popupKnopf()` in `ui.js`). Ist eines offen, löst ein `pointerover`
  mit `pointerType === "mouse"` einfach den **Klick** des überfahrenen Knopfes aus – die Logik
  jedes Menüs bleibt damit an genau einer Stelle. Per Finger passiert nichts, sonst wäre jedes
  Streifen ein Menüwechsel.
- **Kein Seiten-Zoom:** Gezoomt wird im 3D-Bild, nicht an der Oberfläche. Dafür braucht es
  **drei** Stellen, jede allein reicht nicht: `user-scalable=no` im Viewport-Meta (das Chrome
  bewusst überhört), `touch-action: pan-x pan-y` am `body` (fängt Kneifen und Doppeltipp ab und
  lässt Scrollen zu) und ein `wheel`-Handler in `ui.js`, der **nur mit Strg/Cmd**
  `preventDefault()` ruft – ohne die Bedingung stünde jede Liste still. Safaris eigene
  `gesture*`-Ereignisse kommen dazu.
- **„Als Bild speichern"** (`scene.snapshot()`): rendert die Hauptszene EINMAL zusätzlich ohne
  Raster, Bau-Punkte und Beschriftungen und liest den Puffer **sofort** aus – der Renderer läuft
  ohne `preserveDrawingBuffer`, nach dem nächsten Bild wäre er leer. Der Ansichtswürfel fehlt von
  selbst, weil er erst danach über `_renderViewCube()` in denselben Puffer gezeichnet wird.
- **Schwebendes über der Szene:** Szene-Knopf und Ansichtswürfel weichen der Schnittebenen-Leiste,
  sobald sie auf schmalen Schirmen als Leiste über dem Bild liegt – **eine** Quelle dafür ist
  `syncCubeInset()` in `ui.js` (`scene.setViewCubeInset()` + CSS-Variable `--slice-inset`). Eine
  feste Medienabfrage im CSS wäre falsch: sie rückte den Knopf auch dann tiefer, wenn gar keine
  Leiste steht. Die Statuszeile weicht der Aufbau-Karte über `--asm-sheet-h` (ResizeObserver auf
  `#asm-sheet`, damit sie beim Ziehen mitwandert).
- **Dunkelmodus:** Die Wahl (`auto`/`light`/`dark`) steht in `quadro.theme.v1`, gilt als
  `data-theme` am `<html>` und wird vom **Skript im `<head>`** gesetzt – vor dem ersten Bild.
  Über die Module ginge das nicht (`main.js` wartet auf den Katalog), die Seite blitzte hell auf.
  `ui.js` pflegt den Wert nur noch und hängt bei `auto` an
  `matchMedia("(prefers-color-scheme: dark)")`. **Drei Fallen:** Farben nur als Variable (siehe
  Konventionen); `--ink-on-part` bleibt in beiden Schemata dunkel, weil es auf einem Knopf in
  **Teilefarbe** steht (sonst helle Schrift auf Gelb); und `scene.setTheme()` färbt nur
  Hintergrund, Raster und das Ausblassen im Aufbaumodus – die **Szene-Ansicht** bleibt Tag, ihre
  Rasterlinien also hell.
- **Licht in beiden Ansichten:** Das Richtungslicht brennt **immer** – es modelliert die Rohre,
  ohne es steht alles flach in einer Farbe da und gleichfarbige Teile verschwimmen ineinander.
  `setScene()` stellt Stärke und Farbe (Szene: 1,9 warm + Hemisphäre 1,1; normal: 1,1 neutral +
  Hemisphäre 1,0) – und `castShadow`: **geworfene** Schatten gibt es nur in der Szene. Im
  Normal-Modus sind sie bewusst aus, denn sie legen sich über die Nachbarteile und machen genau
  die Unterscheidung wieder kaputt, um die es dort geht.
- **Schnittebene schneidet nur das Modell:** Die Ebene hängt an den **Materialien**
  (`renderer.localClippingEnabled = true`, `material.clippingPlanes`), nicht global am Renderer –
  sonst wären Boden, Gras, Bäume und Himmel gleich mit halbiert. `scene._applyClip()` hängt sie an
  alle Materialien aus `_materials` sowie an `buildGroup`/`handleGroup`/`labelGroup` und läuft
  auch am Ende von `renderModel()`, weil Materialien erst bei ihrer ersten Verwendung entstehen.
  **Zwei Fallen:** die Liste der Ebenen darf nur beim **Wechsel** neu gebaut werden (three
  übersetzt den Shader neu, sobald sich die Anzahl ändert – eine neue Anordnung je Bild hieße
  Neuübersetzen je Bild; der Vergleich `m.clippingPlanes === liste` erkennt „schon gesetzt"), und
  `clipShadows` muss mit, sonst werfen weggeschnittene Teile weiter Schatten. Umgekehrt braucht
  der Ansichtswürfel nichts mehr abzuschalten: seine Materialien tragen die Ebene gar nicht.
- **Layout ohne feste Breakpoints:** `ui.js` setzt Klassen auf `<body>`, das CSS liest nur diese –
  `compact-colors`/`compact-view` (Bauteil-Zeile eng), `compact-head` (Kopfzeile eng),
  `sidebar-overlay`, `mobile-portrait`, `asm-sheet-on`. Die beiden Kollaps-Stufen misst ein
  `ResizeObserver` (`grp-build.scrollWidth > clientWidth`). **Zwei Fallen:** gemessen wird gegen
  `window.innerWidth`, nicht gegen die Leiste selbst (der Kollaps ändert deren Breite – daran
  gemessen schaukelt es sich auf); und zurückgeschaltet wird erst, wenn das Fenster um so viel
  breiter ist, wie der Kollaps damals freigemacht hat (`tightAt`), sonst zuckt es bei jeder
  Zwischenbreite einmal auf und zu. Die Kopfzeile hat dieselbe Mechanik in fünf Stufen
  (`compact-autosave`, `compact-head`, `head-hide-3d`, `head-hide-name`, `compact-brand`):
  wird es eng, verschwindet erst das „3D", dann „QUADRO", zuletzt schrumpft die Marke –
  das Zeichen bleibt immer stehen. Im Hochformat ist Stufe 2 die unterste.
  Kollabiert wird durch **Umhängen des Original-Knotens** (`moveNode`), nicht durch eine zweite
  Garnitur Knöpfe; die Rückkehr-Stelle hält ein Kommentar-Knoten.
- **Zeiger-Eingaben teilen sich `builder.js` und OrbitControls:** ein Finger/die linke Maustaste
  gehören dem Builder (drehen um den Punkt unter dem Zeiger, wählen, bauen), zwei Finger und das
  Rad gehören OrbitControls. Beides muss **getrennt** abgeschaltet werden – `mouseButtons.LEFT`
  gilt nur für die Maus, für den Finger braucht es `controls.touches` (in `scene.js` an **beiden**
  Stellen, die Controls bauen). Der Builder merkt sich außerdem die `pointerId` des laufenden Zugs
  und bricht ihn ab, sobald ein zweiter Finger dazukommt (`_abortGesture`).
- Undo/Redo in `builder.js` arbeiten mit vollständigen JSON-Snapshots (`recordHistory`,
  max. 60 Schritte). Modelländerungen deshalb immer durch `recordHistory(...)` kapseln.
- **Drehen der Auswahl:** `model.rotateSelection(sel, steps, {merge, validate, grid})` dreht in
  90°-Schritten um die **Hochachse** – derselbe Ablauf wie `moveSelection` (trennen, prüfen,
  zusammenlegen), nur mit `_applyTurn` statt `_applyOffset`. Mitgedreht wird **alles Gerichtete**:
  Kupplungs-Quaternionen (`spinAroundY` dreht um die WELT-Y-Achse, `turnAroundY` dagegen um die
  lokale), `stub`, `c45axis`, `arms`, `armDirs` (samt Namen über `cardinalName`), die Datei-Lagen
  von Rohren und Platten (`geom`, `bowCenter`) sowie Klemmen, Rutschen und Anbauteile.
  Die Drehachse ist die **auf 5 cm gerundete Mitte** der Auswahl: bei ungerader Kantenlänge
  (z. B. 45 cm) rückt die Auswahl dabei um 2,5 cm – gewollt, denn außerhalb des Rasters passten
  die Teile nicht mehr zusammen. Bedient wird über **Strg/Cmd + ←/→**, **Q/E** und den Knopf
  `#mode-rotate` (sichtbar wie „Löschen", zusätzlich solange eine Kopie am Zeiger hängt); die
  Kopie dreht sich an Ort und Stelle mit. Während einer Vorschau ruft `builder.refresh()` statt
  `onChange` nur `onPreview` – daran hängt `ui.syncButtons()`, sonst fehlte der Knopf beim
  Einfügen.
- **Vorschau vs. Vollzug (Ziehen und Einfügen):** Während des Zugs wird nur **verschoben**
  (`model.translateSelection`) – nicht getrennt, nicht zusammengelegt, keine Kupplungen geprüft.
  Zu Beginn des Zugs trennt `model.detachSelection(sel)` einmal die Verbindungen zum stehenden
  Rest – sonst zogen sich die angrenzenden Rohre während des Ziehens in die Länge.
  Der echte Zug läuft **einmal** beim Loslassen bzw. Absetzen (`moveSelection` mit `merge`/
  `validate`, `commitPaste`). Früher wurde je Rasterschritt das ganze Modell neu geladen und ein
  vollständiger Zug gerechnet: bei 340 Kupplungen kostete eine Zeigerbewegung ~50 ms, jetzt ~10 ms.
  Passt die Lage nicht, wird die Auswahl **rot** gezeichnet (`opts.invalid` der Szene, gleiche
  Darstellung wie bei der Kopie am Zeiger) statt stehen zu bleiben; beim Loslassen fällt sie auf
  die letzte gültige Lage zurück (`_drag.lastValid`). Die Pfeiltasten bleiben beim alten
  Verhalten – ein Schritt, der nicht geht, wird abgelehnt und gemeldet.
- **`model.collisions({ only })`** prüft über ein grobes Raster (`COLL_CELL = 100` cm) statt jedes
  Rohr mit jedem: nur Rohre in denselben Zellen werden verglichen (425 Rohre: 9,9 ms → 2,1 ms).
  `only` schränkt zusätzlich auf die **bewegten** Rohre ein (`model.tubesAt(knotenIds)`) – stehende
  Rohre können untereinander keine neue Überlagerung bilden (→ 0,3 ms). Ergebnis identisch zum
  Paarvergleich (gegen 200 Zufallsmodelle geprüft).
- **Kopieren/Einfügen** läuft wie das Ziehen einer Auswahl: `model.extractSelection(sel)` schneidet
  ein Fragment heraus (Koordinaten relativ zum `anchor`, `geom`/`pool` fallen weg – sie zeigten
  sonst auf die alte Stelle), `startPaste` setzt es über `model.insertFragment` ins Modell und
  hängt es an den Zeiger. Die Kopie steckt also **wirklich im Modell** – nur so zeichnet die Szene
  sie und nur so lässt sich auf Kollisionen prüfen. Abgesichert ist das an zwei Stellen:
  `ui.captureActiveTab()` sichert `builder.pasteSnapshot()` statt des laufenden Modells (sonst
  landete die Vorschau in Sitzung und Datei), und Tab-Wechsel, Moduswechsel, Escape sowie
  abgebrochene Zeigergesten rufen `cancelPaste()`. Abgesetzt wird nur bei einem **echten Klick**
  (Bewegung unter `CLICK_TOLERANCE`) und nur an gültiger Stelle; mit gedrückter Taste dreht der
  Zug wie sonst die Ansicht – die Kopie folgt dem Zeiger nur mit loser Taste; sonst zeichnet `scene.js` die
  Kopie über `opts.invalid` rot. Die Kopie bleibt auf der **Höhe ihres Ursprungs**
  und wandert nur waagerecht (`scene.pointOnPlane` mit Normale Y) – in drei Achsen zugleich trifft
  man die Stelle nicht; die Höhe stellt man danach mit den Pfeiltasten ein, denn das Eingefügte
  bleibt ausgewählt. Der Versatz an `insertFragment` ist die **Weltstelle der Fragment-Ecke**, nicht
  eine Differenz – die Koordinaten im Fragment liegen bereits relativ zu dieser Ecke. Gerastert
  wird **vom Ursprung der Kopie aus** (`_placePaste`), nicht gegen den Weltnullpunkt: sonst
  rutscht eine Vorlage, die selbst nicht auf dem Raster liegt, beim Einfügen zur Seite. **Während der Vorschau wird nicht gespeichert** (`scheduleDocSave`,
  `scheduleSessionSave` und `evaluateDirty` steigen bei `builder.pasting` aus): sonst schrieb das
  automatische Speichern die schwebende Kopie mit, und eine Server-Übernahme ließ sie verschwinden.
- **Vorschau-Tabs:** ein Klick in „Meine Modelle"/Bibliothek öffnet mit `preview: true`; ein
  zweiter Vorschau-Klick wirft den alten Tab weg (`discardPreview`). Solange ein Tab Vorschau ist,
  zeigt er **keinen** Änderungs-Punkt und fragt beim Schließen nicht nach – er kann nichts
  Ungespeichertes enthalten, denn die erste Änderung heftet ihn an. Angeheftet wird er beim
  Doppelklick, beim Speichern und sobald sich das Modell gegenüber `tab.baseJson` unterscheidet.
  Wie `savedJson` bleibt `baseJson` aus der Sitzung heraus und wird beim Start neu gebildet.
- **Änderungs-Punkt am Tab:** `builder.onChange` feuert bei JEDEM Neuzeichnen, auch bei Auswahl,
  Schnittebene oder Moduswechsel. `ui.touchActiveTab()` setzt deshalb nichts mehr direkt, sondern
  vergleicht entprellt (200 ms) `model.toJSON()` mit `tab.savedJson` – dem Stand, wie er in der
  Datei liegt. Gepflegt wird der beim Öffnen, Speichern und bei Übernahmen vom Server; ein
  importiertes Modell hat `savedJson = null` und gilt bis zum ersten Speichern als geändert. In
  die Sitzung wandert `savedJson` **nicht** (sie wäre doppelt so groß), beim Start wird es aus
  `model`/`dirty` neu gebildet.
- **Kamerastand liegt an zwei Stellen:** `quadro.camera.v1` (zuletzt gesehener Stand, Rückfall für
  Sitzungen ohne Kamera) und – maßgeblich – `tab.view.camera` **je Tab** in der Sitzung. Beim Start
  gewinnt die Sitzung, deshalb muss jede Kamerabewegung auch die **Sitzung** sichern:
  `scene.onCameraChange` schreibt beides. Gemeldet wird aus `scene.js` an **allen** Stellen, die
  die Kamera versetzen – Ende einer Bewegung von OrbitControls oder Builder (`endOrbit`), Ende
  einer Kamerafahrt, `resetCamera()` und `setProjection()`; sonst kommt nach dem Reload der Stand
  von davor zurück. `this.onCameraChange` wird deshalb **vor** dem ersten `resetCamera()` im
  Konstruktor gesetzt.
- **IndexedDB** `quadro.library.v1` (Version 2) hält drei Speicher: `designs` (eingelesene
  QDF-Sammlung, Originaltext + Kennzahlen), `docs` (eigene Modelle als virtuelle Dateien) und
  `session` (die offenen Tabs samt Arbeitsstand – damit übersteht auch Ungespeichertes einen
  Reload). Alles Größere gehört hierhin: `localStorage` teilt 5 MB unter allen Schlüsseln auf,
  ein großes Modell wiegt allein ~150 KB.
- **Backend-Fallen:** Der Service Worker darf `/api/` **nicht** cachen (eine gespeicherte
  Dateiliste wäre offline eine Behauptung) – `sw.js` klinkt diese Pfade früh aus. Ein Abgleich
  darf nie mit einer geratenen Serverliste laufen: `nudge()` ruft bewusst den vollen
  `reconcile()`, sonst hält ein fehlendes Gegenstück eine Datei fälschlich für „anderswo
  gelöscht". Und `?dev` schaltet nur den Service Worker ab, **nicht** das Backend – dafür gibt es
  `?nobackend`.
- In `localStorage` stehen nur noch Einstellungen: `quadro.inventory.v1`, `quadro.sidebarWidth.v1`,
  `quadro.sidebarPanel.v1`, `quadro.autosaveMode.v1`, `quadro.quality.v1`, `quadro.slice.v1`,
  `quadro.camera.v1`, `quadro.projection.v1`, `quadro.scene.v1`, `quadro.migrated.v2`,
  `quadro.clientId.v1`, `quadro.inventory.meta.v1`, Sprache in `i18n.js`. Die alten Schlüssel `quadro.autosave.v1`/`quadro.design.v1.<name>` werden beim ersten
  Start einmalig nach `docs` übernommen (`docs.migrateOldDrafts()`) und danach nur noch gelesen.
  `quadro.autosave.v1` dient dabei nur noch als Rückfall, wenn es **gar keine** Sitzung gibt –
  eine leere Sitzung (alle Tabs zu) startet mit einem leeren Entwurf.
- Dev-Hook: App mit `?dev` in der URL öffnen ⇒ `window.__qdf.import(text)` importiert QDF
  programmatisch (für Tests aus der Konsole).
- `scene.js` cached Materialien/Geometrien bewusst (GPU-Leaks); neue Materialien nach diesem
  Muster anlegen und in `_disposeGroup`/`_disposeLabels` mit aufräumen.
- `docs/screenshots/` hält die Bilder für das README; die alten zeigen noch den Namen
  „Quadro Builder" und sind deshalb gerade nicht eingebunden.
