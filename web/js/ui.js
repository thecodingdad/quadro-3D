// Verkabelt die Bedienoberflaeche (Toolbar, Tastatur, Stueckliste, Bestand).

import { buildableTubes, buildableCurvedTubes, buildablePanels, tubeColors, geometry, allTubes, allConnectors, panels, reinforcements, screws, slideKindName, partName, partForFitting, accessories, getPartById, poolLinerFor, getTube, getPanel } from "./catalog.js";
import { PLACEABLE_FITTINGS, POOL_KINDS, HOLE_MASKS, ROTATABLE_FITTINGS, SLIDE_PARTS } from "./model.js";
import { computeBOM, compareInventory, connectorsForNode } from "./bom.js";
import { computeBuildPlan, BUILD_ORDERS } from "./buildplan.js";
import { parseQDF } from "./qdfimport.js";
import { QUALITY_LEVELS } from "./scene.js";
import { RANDOM_COLOR, MOVE_STEPS } from "./builder.js";
import * as storage from "./storage.js";
import * as docs from "./docs.js";
import * as sync from "./sync.js";
import { designEntry, parseDesign, checkAgainstInventory, missingCount } from "./library.js";
import { buildQDF } from "./qdfexport.js";
import { t, getLang, setLang, applyTranslations } from "./i18n.js";

function $(id) { return document.getElementById(id); }

// Zeitstempel "YYYY-MM-DD HH:MM" fuer eindeutige Entwurf-Namen beim Import.
function importStamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function eur(v) { return v.toFixed(2).replace(".", ",") + " €"; }
/** Gebietsschema für Datum und Uhrzeit: die App-Sprache, nicht die des Browsers. */
function locale() { return getLang() === "de" ? "de-DE" : "en-US"; }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function neg(v) { return [-v[0], -v[1], -v[2]]; }

// --- Dialoge --------------------------------------------------------------
// Alle Rückfragen laufen über eine Karte im Dokument. Browser-Popups (alert,
// confirm, prompt) blockieren den Tab, sehen in jedem Browser anders aus und
// passen nicht zum übrigen Bild.

let dialogFertig = null;

/** Steht gerade ein Dialog offen? (Tastenkürzel pausieren dann.) */
function dialogOpen() { return !!dialogFertig; }

/**
 * Karte anzeigen und auf die Antwort warten.
 *
 * `buttons` sind `{ key, label, kind }`; der erste Knopf ist die Vorgabe für
 * Enter, `kind` ist die CSS-Klasse ("ghost", "danger"). Escape und ein Klick
 * neben die Karte antworten mit `cancelKey`. Mit `input` erscheint ein
 * Textfeld. Ergebnis: `{ key, value }` oder `null` beim Abbruch.
 */
function dialog({ title, text = "", input = null, buttons = [], cancelKey = null }) {
  // Ein zweiter Dialog verdrängt den ersten -- offene Zusagen laufen leer.
  if (dialogFertig) dialogFertig(null);
  return new Promise((resolve) => {
    const box = $("dlg-overlay"), feld = $("dlg-input"), leiste = $("dlg-actions");
    $("dlg-title").textContent = title || "";
    $("dlg-text").textContent = text || "";
    $("dlg-text").hidden = !text;
    feld.hidden = !input;
    feld.value = input ? (input.value || "") : "";
    feld.placeholder = input ? (input.placeholder || "") : "";

    const fertig = (key) => {
      dialogFertig = null;
      box.hidden = true;
      window.removeEventListener("keydown", taste, true);
      box.removeEventListener("mousedown", daneben);
      leiste.innerHTML = "";
      resolve(key == null ? null : { key, value: feld.value.trim() });
    };
    const taste = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); fertig(cancelKey); }
      else if (e.key === "Enter" && buttons.length) { e.preventDefault(); e.stopPropagation(); fertig(buttons[0].key); }
    };
    const daneben = (e) => { if (e.target === box) fertig(cancelKey); };

    leiste.innerHTML = "";
    for (const b of buttons) {
      const knopf = el("button", b.kind ? `btn ${b.kind}` : "btn", b.label);
      knopf.addEventListener("click", () => fertig(b.key));
      leiste.appendChild(knopf);
    }
    dialogFertig = fertig;
    box.hidden = false;
    window.addEventListener("keydown", taste, true);
    box.addEventListener("mousedown", daneben);
    if (input) { feld.focus(); feld.select(); } else leiste.firstChild?.focus();
  });
}

/** Ja/Nein-Rückfrage. Liefert true, wenn bestätigt wurde. */
function askConfirm(text, { title = t("dlg_confirm_title"), ok = t("dlg_ok"), danger = false } = {}) {
  return dialog({
    title, text, cancelKey: "cancel",
    buttons: [
      { key: "ok", label: ok, kind: danger ? "danger" : "" },
      { key: "cancel", label: t("ask_cancel"), kind: "ghost" },
    ],
  }).then((r) => !!r && r.key === "ok");
}

/** Texteingabe. Liefert den (getrimmten) Text oder null bei Abbruch. */
function askInput(text, vorgabe = "", { title = t("dlg_input_title"), ok = t("dlg_ok") } = {}) {
  return dialog({
    title, text, input: { value: vorgabe }, cancelKey: "cancel",
    buttons: [
      { key: "ok", label: ok },
      { key: "cancel", label: t("ask_cancel"), kind: "ghost" },
    ],
  }).then((r) => (r && r.key === "ok" && r.value ? r.value : null));
}

/** Meldung mit einem einzigen Knopf -- Ersatz für alert(). */
function showMessage(text, { title = t("dlg_error_title") } = {}) {
  return dialog({ title, text, cancelKey: "ok", buttons: [{ key: "ok", label: t("dlg_ok") }] });
}

// Rückfragen des Server-Abgleichs kommen von selbst -- sie dürfen keine Karte
// verdrängen, vor der gerade jemand sitzt (ein zweiter `dialog()` beendet den
// ersten mit "Abbruch"). Deshalb laufen sie nacheinander und warten, bis die
// Oberfläche frei ist.
let dialogChain = Promise.resolve();
function queueDialog(fn) {
  const next = dialogChain.then(async () => {
    while (dialogOpen()) await new Promise((r) => setTimeout(r, 200));
    return fn();
  }).catch((e) => { console.warn("Rückfrage:", e); return null; });
  dialogChain = next.then(() => {}, () => {});
  return next;
}

function loadInv() {
  const inv = storage.loadInventory() || {};
  inv.tubes = inv.tubes || {};
  inv.connectors = inv.connectors || {};
  inv.panels = inv.panels || {};
  inv.reinforcements = inv.reinforcements || {};
  inv.fittings = inv.fittings || {};
  inv.screws = inv.screws || {};
  return inv;
}
function saveInv(inv) { storage.saveInventory(inv); }

/** Rendert die Hilfe-Tabelle aus den Übersetzungen neu. */
/**
 * Tastenkuerzel-Karte: je Thema ein Block aus Kuerzel und Erklaerung. Wie viele
 * Bloecke nebeneinander stehen, entscheidet die Breite (CSS-Spalten) -- die
 * Liste ist zu lang fuer eine einzige Spalte geworden.
 */
function renderHelpTable() {
  const box = $("help-table");
  if (!box) return;
  box.innerHTML = "";
  // {n} = Zahl der geraden Rohre: die Zifferntasten reichen genau so weit.
  const ziffern = String(buildableTubes().length);
  for (const [titel, eintraege] of t("help_groups")) {
    const gruppe = document.createElement("section");
    gruppe.className = "help-group";
    const h = document.createElement("h4");
    h.textContent = titel;
    gruppe.appendChild(h);
    const liste = document.createElement("dl");
    for (const [key, desc] of eintraege) {
      const dt = document.createElement("dt"); dt.textContent = key.replace("{n}", ziffern);
      const dd = document.createElement("dd"); dd.textContent = desc;
      liste.appendChild(dt); liste.appendChild(dd);
    }
    gruppe.appendChild(liste);
    box.appendChild(gruppe);
  }
}

export function initUI({ scene, model, builder }) {
  // Kopierter Ausschnitt (Strg+C). Er lebt im Speicher der Seite: zwischen
  // Entwurf-Tabs einfügbar, nach einem Reload weg.
  let clipboard = null;
  let slideGroupBtn = null;
  let renderFittingButton = () => {};
  const inventory = loadInv();

  // Übersetzungen initial anwenden
  applyTranslations();
  renderHelpTable();

  // Sprach-Dropdown (direkt in toolbar-right)
  const langBtn = $("btn-lang");
  if (langBtn) {
    langBtn.value = getLang();
    langBtn.addEventListener("change", () => {
      const next = langBtn.value;
      setLang(next);
      applyTranslations();
      renderHelpTable();
      renderColorButtons();
      applyViewCubeLabels();
      renderOrderOptions();
      renderPartButtons();
      renderThemeOptions();
      renderQualityOptions();
      renderSyncLine();
      renderLibHint();
      renderLibSort();
      renderGridButton();
      // Die Zeilen des Hauptmenues im Hochformat bauen ihre Beschriftungen
      // selbst -- applyTranslations erwischt sie nicht.
      renderMenuFileRows(document.body.classList.contains("mobile-portrait"));
      renderTabs();          // der Schliessen-Knopf jedes Tabs traegt einen Tooltip
      renderFittingButton();
      syncProjectionButton();
      // Dynamische UI-Texte aktualisieren
      setMode(builder.mode);
      update();
    });
  }

  // Beschriftung des Ansichtswuerfels. scene.js kennt die Sprachdateien nicht,
  // deshalb kommen die sechs Woerter von hier -- auch nach jedem Sprachwechsel.
  function applyViewCubeLabels() {
    scene.setViewCubeLabels({
      right: t("cube_right"), left: t("cube_left"),
      top: t("cube_top"), bottom: t("cube_bottom"),
      front: t("cube_front"), back: t("cube_back"),
    });
  }
  applyViewCubeLabels();

  // --- Hinweise + Undo-Verfuegbarkeit ------------------------------------
  builder.onNotice = (msg, art) => flash(msg, art);
  builder.onHistoryChange = () => updateUndoButton();
  // Ein Klick ins Leere hebt die Hervorhebung im Bild auf -- dann darf auch in
  // Stückliste, Bestand und Aufbau keine Zeile mehr markiert stehen.
  // Wechselt jemand von der Maus zum Finger (oder zurueck), gilt sofort der
  // andere Hinweis. Beim Start entscheidet die Geraeteart, damit auf dem Telefon
  // nicht erst der Maus-Hinweis steht.
  if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) builder.inputType = "touch";
  builder.onInputTypeChange = () => { if (builder.mode === "select") setMode(builder.mode); };

  builder.onHighlightCleared = () => {
    bomHighlightKey = null;
    invHighlightKey = null;
    asmHighlightKey = null;
    update();
    renderAssembly();
  };
  // Dasselbe beim Klick in den LEEREN Bereich einer Liste: nicht jeder greift
  // dafür zur Zeichenfläche, und eine markierte Zeile ohne Weg zurück ist
  // ärgerlich. Klicks auf Zeilen und Bedienelemente bleiben unberührt.
  for (const panelId of ["panel-bom", "panel-assembly"]) {
    const box = $(panelId);
    if (!box) continue;
    box.addEventListener("click", (e) => {
      if (!builder.highlight) return;
      if (e.target.closest(".bom-row, .asm-row, button, input, select, label, a")) return;
      builder.setHighlight(null);
      builder.onHighlightCleared();
    });
  }
  function updateUndoButton() {
    $("btn-undo").disabled = !builder.canUndo();
    $("btn-redo").disabled = !builder.canRedo();
  }



  // Die Datei-Aktionen stehen jetzt als einzelne Knöpfe in der Kopfzeile.
  // toggleFileMenu bleibt als Attrappe, damit die Aufrufe in den Handlern
  // nichts kaputt machen.
  function toggleFileMenu() { /* kein Menü mehr */ }

  /** Popup fixed unter einem Anker-Button platzieren, am rechten Rand geklemmt. */
  function placePopupUnder(pop, anchorBtn) {
    // ZUERST aus dem Fluss nehmen, dann messen: als normales Kind von <body>
    // (Flex-Spalte) drueckt das Popup die Leisten zusammen -- der Anker saesse
    // beim Messen woanders als gleich darauf.
    pop.style.position = "fixed";
    pop.style.top = "0px";
    pop.style.left = "0px";
    const rect = anchorBtn.getBoundingClientRect();
    pop.style.left = rect.left + "px";
    pop.style.right = "auto";
    // Steht die Bedienleiste unten (Hochformat), klappen ihre Popups nach OBEN
    // auf -- direkt an den Knopf, spiegelbildlich zur Leiste oben. Verankert
    // wird dann die UNTERKANTE: die Hoehe des Popups zu messen geht schief,
    // solange der Browser noch nicht umgebrochen hat.
    const nachOben = document.body.classList.contains("mobile-portrait")
      && $("toolbar-ctx").contains(anchorBtn);
    if (nachOben) {
      pop.style.top = "auto";
      pop.style.bottom = (window.innerHeight - rect.top + 5) + "px";
      pop.style.maxHeight = Math.max(120, rect.top - 16) + "px";
    } else {
      pop.style.bottom = "auto";
      pop.style.top = (rect.bottom + 5) + "px";
    }
    requestAnimationFrame(() => {
      const maxLeft = window.innerWidth - pop.offsetWidth - 8;
      if (parseFloat(pop.style.left) > maxLeft) pop.style.left = Math.max(8, maxLeft) + "px";
      // Am oberen Rand angeschlagen? Dann doch nach oben klappen.
      if (!nachOben && rect.bottom + 5 + pop.offsetHeight > window.innerHeight - 8) {
        pop.style.top = "auto";
        pop.style.bottom = (window.innerHeight - rect.top + 5) + "px";
      }
    });
  }
  // --- Schnittebene ------------------------------------------------------
  // Schneidet das Modell entlang einer Achse auf, damit man hineinsehen und
  // weiter innen bauen kann. Kein eigener Modus: laeuft parallel zu Bauen,
  // Platten setzen usw. weiter.
  const SLICE_KEY = "quadro.slice.v1";
  // Die Schalter folgen der CAD-Konvention (Z zeigt nach oben), das Modell der
  // Three.js-Konvention (Y zeigt nach oben). Der Schalter "Z" schneidet
  // deshalb entlang der internen Y-Achse und legt die Ebene in X/Y -- so, wie
  // man es aus Fusion & Co. kennt.
  const SLICE_AXIS = { x: "x", y: "z", z: "y" };
  const sliceBar = $("slice-bar");
  const sliceRange = $("slice-range");
  // values haelt die zuletzt benutzte Lage JE ACHSE fest: Aus- und Einschalten
  // und ein Wechsel der Achse sollen die Ebene dort wieder aufnehmen, wo man
  // sie verlassen hat. null = fuer diese Achse noch nie gesetzt -> mittig.
  const slice = { on: false, axis: "z", value: 0, flip: false,
                  values: { x: null, y: null, z: null } };
  try {
    const st = JSON.parse(localStorage.getItem(SLICE_KEY));
    if (st && ["x", "y", "z"].includes(st.axis) && typeof st.value === "number") {
      Object.assign(slice, { on: !!st.on, axis: st.axis, value: st.value, flip: !!st.flip });
      if (st.values) for (const a of ["x", "y", "z"])
        if (typeof st.values[a] === "number") slice.values[a] = st.values[a];
      // Aeltere Staende kannten nur EINEN Wert -- der gehoert zur aktiven Achse.
      if (slice.values[slice.axis] == null) slice.values[slice.axis] = slice.value;
    }
  } catch { /* kaputter Eintrag -> Standard */ }

  /** Lage fuer die aktive Achse holen; beim ersten Mal in die Mitte legen. */
  function sliceValueForAxis() {
    const stored = slice.values[slice.axis];
    if (stored != null) return stored;
    const lim = sliceLimits();
    return Math.round((lim.min + lim.max) / 2);
  }

  function sliceLimits() {
    const b = model.bounds(geometry().connectorSize / 2);
    if (!b) return { min: -100, max: 100 };
    const ax = SLICE_AXIS[slice.axis];
    const i = ax === "x" ? 0 : ax === "y" ? 1 : 2;
    return { min: Math.floor(b.min[i]), max: Math.ceil(b.max[i]) };
  }

  function applySlice() {
    if (!sliceBar) return;
    sliceBar.hidden = !slice.on;
    requestAnimationFrame(syncCubeInset);
    $("btn-slice").classList.toggle("active", slice.on);
    if (!slice.on) { scene.clearClip(); builder.refresh(); return; }
    const lim = sliceLimits();
    sliceRange.min = lim.min;
    sliceRange.max = lim.max;
    slice.value = Math.min(lim.max, Math.max(lim.min, slice.value));
    slice.values[slice.axis] = slice.value;
    sliceRange.value = slice.value;
    $("slice-value").textContent = `${Math.round(slice.value)} cm`;
    for (const b of $("slice-axes").querySelectorAll("button"))
      b.classList.toggle("active", b.dataset.axis === slice.axis);
    scene.setClip(SLICE_AXIS[slice.axis], slice.value, slice.flip);
    builder.refresh();   // Handles neu: verdeckte sind nicht mehr anklickbar
  }

  function saveSlice() {
    localStorage.setItem(SLICE_KEY, JSON.stringify(slice));
  }

  if (sliceBar) {
    $("btn-slice").addEventListener("click", () => {
      slice.on = !slice.on;
      // Beim Einschalten die zuletzt benutzte Lage dieser Achse wieder
      // aufnehmen -- frueher sprang die Ebene jedes Mal in die Mitte.
      if (slice.on) slice.value = sliceValueForAxis();
      applySlice(); saveSlice();
    });
    $("slice-close").addEventListener("click", () => { slice.on = false; applySlice(); saveSlice(); });
    $("slice-flip").addEventListener("click", () => { slice.flip = !slice.flip; applySlice(); saveSlice(); });
    for (const b of $("slice-axes").querySelectorAll("button")) {
      b.addEventListener("click", () => {
        slice.axis = b.dataset.axis;
        slice.value = sliceValueForAxis();
        applySlice(); saveSlice();
      });
    }
    sliceRange.addEventListener("input", () => {
      slice.value = parseFloat(sliceRange.value);
      // Auch beim Ziehen mitschreiben -- applySlice() laeuft hier nicht.
      slice.values[slice.axis] = slice.value;
      $("slice-value").textContent = `${Math.round(slice.value)} cm`;
      scene.setClip(SLICE_AXIS[slice.axis], slice.value, slice.flip);
    });
    // Erst beim Loslassen neu aufbauen -- waehrend des Ziehens waere das zaeh.
    sliceRange.addEventListener("change", () => { builder.refresh(); saveSlice(); });
    // Gemerkten Schnitt beim Start wiederherstellen.
    if (slice.on) applySlice();
  }

  // --- Kamera merken -----------------------------------------------------
  // Position, Blickziel und Zoom ueberleben einen Reload; sonst landet man
  // immer wieder in der Standardansicht.
  //
  // ZWEI Ablagen, und beide muessen mit: `quadro.camera.v1` haelt den zuletzt
  // gesehenen Stand fuer den allerersten Tab, die Sitzung dagegen den Stand JE
  // TAB (`tab.view.camera`). Beim Start gewinnt die Sitzung -- deshalb reicht
  // es nicht, hier nur localStorage zu schreiben: wer nur die Ansicht drehte
  // und neu lud, bekam den Stand aus der letzten Modellaenderung zurueck oder,
  // wenn es keine gab, die Standardansicht.
  const CAMERA_KEY = "quadro.camera.v1";
  // Die Sitzung liegt EINMAL in der Datenbank -- mehrere BROWSER-Fenster teilen
  // sie sich und überschreiben darin gegenseitig ihre Ansicht. Die Kamera
  // gehört aber zum Fenster, nicht zum Entwurf: sie liegt deshalb zusätzlich im
  // `sessionStorage`, den jedes Fenster für sich hat und der einen Reload
  // übersteht. Beim Start gewinnt dieser Stand -- so kommt jedes Fenster in
  // seiner eigenen Ansicht zurück.
  const CAMVIEW_KEY = "quadro.camview.v1";
  function fensterKameras() {
    try { return JSON.parse(sessionStorage.getItem(CAMVIEW_KEY)) || {}; } catch { return {}; }
  }
  function merkeFensterKamera(tabId, st) {
    if (!tabId || !st) return;
    const alle = fensterKameras();
    alle[tabId] = st;
    // Geschlossene Tabs mitnehmen wäre Ballast -- nur die offenen bleiben.
    const offen = new Set(tabs.map((x) => x.tabId));
    for (const id of Object.keys(alle)) if (id !== tabId && !offen.has(id)) delete alle[id];
    try { sessionStorage.setItem(CAMVIEW_KEY, JSON.stringify(alle)); } catch { /* voll */ }
  }

  let camSaveTimer = null;
  scene.onCameraChange = () => {
    clearTimeout(camSaveTimer);
    camSaveTimer = setTimeout(() => {
      const st = scene.cameraState();
      if (st) {
        localStorage.setItem(CAMERA_KEY, JSON.stringify(st));
        merkeFensterKamera(activeTabId, st);
      }
      scheduleSessionSave();
    }, 400);
  };

  // Beim Verstecken oder Verlassen der Seite SOFORT sichern. Die Entprellung
  // (400 ms Kamera, 600 ms Sitzung) verschluckte den letzten Stand sonst: wer
  // gleich nach dem Drehen neu lud, bekam die vorige Ansicht zurück.
  function sichereSofort() {
    clearTimeout(camSaveTimer);
    clearTimeout(sessionTimer);
    const st = scene.cameraState();
    if (st) {
      try { localStorage.setItem(CAMERA_KEY, JSON.stringify(st)); } catch { /* voll */ }
      merkeFensterKamera(activeTabId, st);
    }
    if (builder.pasting) return;   // wie scheduleSessionSave: Vorschau nicht sichern
    captureActiveTab();
    const lean = tabs.map(({ savedJson, baseJson, ...rest }) => rest);
    docs.saveSession({ tabs: lean, activeTabId }).catch(() => { /* beim Schliessen egal */ });
  }
  document.addEventListener("visibilitychange", () => { if (document.hidden) sichereSofort(); });
  window.addEventListener("pagehide", sichereSofort);

  // --- Rasterweite beim Verschieben --------------------------------------
  // Sie gilt fuer Pfeiltasten, Ziehen und Einfuegen -- nicht fuer das Bauen
  // selbst, das folgt den Rohrlaengen. Gemerkt wird sie global: sie gehoert zur
  // Arbeitsweise, nicht zum einzelnen Entwurf.
  const GRID_STEP_KEY = "quadro.moveStep.v1";
  const gridBtn = $("btn-grid");
  const gridWert = $("btn-grid-value");
  const gemerkterSchritt = Number(localStorage.getItem(GRID_STEP_KEY));
  if (MOVE_STEPS.includes(gemerkterSchritt)) builder.setMoveStep(gemerkterSchritt);

  function renderGridButton() {
    if (gridWert) gridWert.textContent = t("grid_step", builder.moveStep);
    // Das Bodenraster zeigt dieselbe Weite -- sonst sagt das Bild etwas anderes
    // als die Pfeiltasten tun.
    scene.setGridCell(builder.moveStep);
  }
  renderGridButton();

  if (gridBtn) {
    gridBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (togglePopup(gridBtn)) return;
      closePopup();
      const pop = el("div", "part-popup");
      for (const cm of MOVE_STEPS) {
        const row = el("button", "part-popup-row" + (cm === builder.moveStep ? " active" : ""));
        row.appendChild(el("span", "pp-name", t("grid_step", cm)));
        row.addEventListener("click", (ev) => {
          ev.stopPropagation();
          builder.setMoveStep(cm);
          localStorage.setItem(GRID_STEP_KEY, String(cm));
          renderGridButton();
          closePopup();
        });
        pop.appendChild(row);
      }
      document.body.appendChild(pop);
      placePopupUnder(pop, gridBtn);
      activePopup = pop;
      popupAnchor = gridBtn;
      popupOpenedAt = performance.now();
      setTimeout(() => document.addEventListener("click", onPopupOutsideClick, true), 0);
    });
  }

  // --- Kamera-Projektion -------------------------------------------------
  // Orthogonal = keine Fluchtpunkte: parallele Rohre bleiben parallel, gut zum
  // Ausmessen und Vergleichen. Perspektivisch = raeumlicher Eindruck.
  const PROJECTION_KEY = "quadro.projection.v1";
  const projBtn = $("btn-projection");
  function syncProjectionButton() {
    if (!projBtn) return;
    const ortho = scene.projection === "orthographic";
    projBtn.classList.toggle("active", ortho);
    projBtn.title = t(ortho ? "btn_projection_ortho" : "btn_projection_persp");
  }
  if (projBtn) {
    const savedProj = localStorage.getItem(PROJECTION_KEY);
    if (savedProj) scene.setProjection(savedProj);
    syncProjectionButton();
    // Erst Projektion, dann Kamera: setProjection() setzt den Zoom zurueck.
    try {
      const st = JSON.parse(localStorage.getItem(CAMERA_KEY));
      if (st) scene.restoreCameraState(st);
    } catch { /* kaputter Eintrag -> Standardansicht */ }
    projBtn.addEventListener("click", () => {
      const next = scene.projection === "orthographic" ? "perspective" : "orthographic";
      scene.setProjection(next);
      localStorage.setItem(PROJECTION_KEY, next);
      syncProjectionButton();
      flash(t(next === "orthographic" ? "btn_projection_ortho" : "btn_projection_persp"), "info");
    });
  }

  // --- Einstellungen -----------------------------------------------------
  // Farbschema: "auto" folgt dem System, sonst gilt die Wahl. Gesetzt wird es
  // als data-theme am <html> -- das CSS liest nur diese Marke, und das Skript
  // im <head> setzt sie schon vor dem ersten Bild (siehe index.html).
  const THEME_KEY = "quadro.theme.v1";
  const THEME_MODES = ["auto", "light", "dark"];
  const mqDark = window.matchMedia("(prefers-color-scheme: dark)");
  const themeSelect = $("theme-select");
  let themeMode = THEME_MODES.includes(localStorage.getItem(THEME_KEY))
    ? localStorage.getItem(THEME_KEY) : "auto";

  function applyTheme(mode, save = true) {
    themeMode = THEME_MODES.includes(mode) ? mode : "auto";
    const dark = themeMode === "dark" || (themeMode === "auto" && mqDark.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    // Die Szene faerbt Hintergrund und Raster mit; ihre Materialien fuer den
    // Aufbaumodus haengen ebenfalls am Schema -> einmal neu zeichnen.
    if (scene.setTheme(dark)) builder.refresh();
    if (themeSelect) themeSelect.value = themeMode;
    if (save) localStorage.setItem(THEME_KEY, themeMode);
  }

  function renderThemeOptions() {
    if (!themeSelect) return;
    themeSelect.innerHTML = "";
    for (const mode of THEME_MODES) {
      const o = el("option", null, t("theme_" + mode));
      o.value = mode;
      themeSelect.appendChild(o);
    }
    themeSelect.value = themeMode;
  }

  if (themeSelect) {
    renderThemeOptions();
    themeSelect.addEventListener("change", () => applyTheme(themeSelect.value));
  }
  applyTheme(themeMode, false);
  // Stellt das System um, zieht "Auto" mit -- eine feste Wahl nicht.
  mqDark.addEventListener("change", () => { if (themeMode === "auto") applyTheme("auto", false); });

  // Render-Qualitaet: nur die Aufloesung der Geometrien, keine Masse. Wird in
  // localStorage gemerkt und beim Start angewendet.
  const QUALITY_KEY = "quadro.quality.v1";
  const settingsMenu = $("settings-menu");
  const qualitySelect = $("quality-select");

  function renderQualityOptions() {
    if (!qualitySelect) return;
    qualitySelect.innerHTML = "";
    for (const level of QUALITY_LEVELS) {
      const o = el("option", null, t("quality_" + level));
      o.value = level;
      qualitySelect.appendChild(o);
    }
    qualitySelect.value = scene.quality;
  }

  function toggleSettingsMenu(open) {
    const pop = $("settings-pop");
    const show = open == null ? pop.hidden : open;
    pop.hidden = !show;
    $("btn-settings").classList.toggle("active", show);
  }

  if (qualitySelect) {
    const saved = localStorage.getItem(QUALITY_KEY);
    if (saved && scene.setQuality(saved)) builder.refresh();
    renderQualityOptions();
    qualitySelect.addEventListener("change", () => {
      if (scene.setQuality(qualitySelect.value)) builder.refresh();
      localStorage.setItem(QUALITY_KEY, qualitySelect.value);
    });
    $("btn-settings").addEventListener("click", (e) => { e.stopPropagation(); toggleSettingsMenu(); });
    document.addEventListener("click", (e) => {
      if (settingsMenu && !settingsMenu.contains(e.target)) toggleSettingsMenu(false);
    });
  }

  // --- Installieren (PWA) ------------------------------------------------
  // Der Browser meldet selbst, wenn die App installierbar ist. Vorher hat ein
  // Knopf keinen Sinn, deshalb steht der Abschnitt bis dahin auf hidden.
  let installAngebot = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installAngebot = e;
    $("install-section").hidden = false;
  });
  $("btn-install").addEventListener("click", async () => {
    if (!installAngebot) return;
    installAngebot.prompt();
    const { outcome } = await installAngebot.userChoice;
    installAngebot = null;
    $("install-section").hidden = true;
    toggleSettingsMenu(false);
    if (outcome === "accepted") flash(t("flash_installed"));
  });
  window.addEventListener("appinstalled", () => {
    installAngebot = null;
    $("install-section").hidden = true;
  });

  // --- Hamburger-Menü (Mobile) -------------------------------------------
  const hamburgerBtn = $("btn-hamburger");
  const hamburgerInner = $("toolbar-right-inner");
  function toggleHamburger(open) {
    const show = open == null ? !hamburgerInner.classList.contains("open") : open;
    hamburgerInner.classList.toggle("open", show);
    hamburgerBtn.classList.toggle("active", show);
  }
  if (hamburgerBtn) {
    hamburgerBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleHamburger(); });
    // Im Hochformat ist die Marke der zweite Weg ins Menue -- oben links, wo
    // der Daumen sowieso hinlangt, und dort, wo vorher "Datei" stand.
    document.querySelector(".brand").addEventListener("click", (e) => {
      if (!document.body.classList.contains("mobile-portrait")) return;
      e.stopPropagation();
      toggleHamburger();
    });
    document.addEventListener("click", (e) => {
      if (!hamburgerInner.contains(e.target) && e.target !== hamburgerBtn)
        toggleHamburger(false);
    });
  }


  // --- Modus -------------------------------------------------------------
  // Modus-Wechsel aus dem Menue heraus: das Menue hat seinen Zweck erfuellt
  // und macht sonst die halbe Szene zu.
  $("mode-add").addEventListener("click", () => { toggleHamburger(false); setMode("add"); });
  $("mode-select").addEventListener("click", () => setMode("select"));
  $("mode-clamp").addEventListener("click", () => setMode("clamp"));
  // Loeschen arbeitet auf der Cursor-Auswahl; der Button ist sonst ausgeblendet.
  $("mode-delete").addEventListener("click", () => {
    const n = builder.deleteSelection();
    if (n) flash(t("flash_deleted_n", n));
    syncDeleteButton();
  });
  // Drehen: 90 Grad je Druck, im Uhrzeigersinn von oben. Gilt fuer die Auswahl
  // und fuer eine Kopie, die noch am Zeiger haengt.
  $("mode-rotate").addEventListener("click", () => {
    if (builder.rotateSelectionBy(1)) flash(t("flash_rotated"));
  });
  // Verstaerken ist eine Gruppe wie Rohre oder Platten: der Knopf oeffnet die
  // Liste, gewaehlt wird darin. Zu kaufen gibt es nur das Holz-Profil 80 cm --
  // bis es ein zweites Teil gibt, steht dort eben genau eine Zeile.
  $("mode-reinforce").addEventListener("click", (e) => {
    e.stopPropagation();
    const items = reinforcements();
    if (!items.length) return;
    const icon = () => svg16(REINFORCE_ICON);
    showPartPopup($("mode-reinforce"), items,
      builder.mode === "reinforce" ? items[0].id : null, icon,
      () => setMode("reinforce"));
  });
  $("mode-assembly").addEventListener("click", () => { toggleHamburger(false); setMode("assembly"); });


  function syncPartHighlights() {
    renderCurrentPart();
    const inAdd = builder.mode === "add";
    const inPanel = builder.mode === "panel";
    // Die Buttons zeigen die Auswahl (auch wenn sie per Tastatur kam) und
    // markieren per .active, welcher der beiden Bau-Modi gerade laeuft.
    renderPartButtons();
    tubeBtn.classList.toggle("active", inAdd);
    panelBtn.classList.toggle("active", inPanel);
    if (slideGroupBtn) {
      slideGroupBtn.classList.toggle("active", builder.mode === "slide");
      // Beschriftung nach einem Sprachwechsel nachziehen; im Titel steht, welches
      // Teil gerade gewaehlt ist.
      slideGroupBtn.lastChild.textContent = t("grp_slides");
      slideGroupBtn.title = `${t("grp_slides")}: ${slideKindName(builder.slideKind)}`;
    }
    renderFittingButton();
    syncPartColors();
  }

  /**
   * Loeschen- und Dreh-Knopf: sichtbar, wenn im Cursor-Modus etwas ausgewaehlt
   * ist. Gedreht wird auch eine Kopie, die noch am Zeiger haengt -- geloescht
   * nicht, die ist ja noch gar nicht gesetzt.
   */
  function syncDeleteButton() {
    const on = builder.mode === "select" && builder.selection.size > 0;
    const drehbar = on || builder.pasting;
    $("mode-delete").hidden = !on;
    $("mode-rotate").hidden = !drehbar;
    $("delete-divider").hidden = !drehbar;
  }

  /** Alle Knöpfe zum Bauen sperren oder freigeben (Aufbau-Modus). */
  function setzeBauteileGesperrt(gesperrt) {
    // #btn-view bleibt frei: dahinter stecken die Ansichts-Schalter, die auch
    // im Aufbau-Modus nutzbar sein sollen (Schraeg darin sperrt ueber build-opt).
    const bereiche = ["#grp-build", "#btn-color",
                      "#mode-delete", "#btn-undo", "#btn-redo"];
    for (const wahl of bereiche) {
      for (const el2 of document.querySelectorAll(`${wahl}, ${wahl} button, ${wahl} input`)) {
        // Ansicht bleibt bedienbar -- ausser den Bau-Schaltern, die dort stehen.
        if (el2.closest(".view-row") && !el2.classList.contains("build-opt")) continue;
        if (el2.tagName === "BUTTON" || el2.tagName === "INPUT") el2.disabled = gesperrt;
      }
    }
    $("toolbar-ctx").classList.toggle("locked", gesperrt);
    if (!gesperrt) { updateUndoButton(); syncDeleteButton(); }
  }

  // --- Statuszeile unten links -------------------------------------------
  // Sie sagt dauerhaft, was das laufende Werkzeug erwartet ("Kupplung waehlen,
  // dann gruenen Punkt klicken"). Kurze Rueckmeldungen ("Rohr 35 cm gesetzt")
  // legen sich fuer ein paar Sekunden darueber; danach steht wieder der
  // Hinweis da, statt dass die Zeile beim Vollzug der letzten Tat verharrt.
  const FLASH_MS = 3500;
  let statusHint = "";
  let flashTimer = null;

  /** Dauerhafter Hinweis zum laufenden Werkzeug. */
  function setStatusHint(text) {
    statusHint = text;
    $("status").className = "status";
    // Ein Werkzeugwechsel raeumt eine noch stehende Meldung ab -- sie gehoert
    // zum vorigen Werkzeug.
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
    $("status").textContent = text;
  }

  /**
   * Kurze Rueckmeldung; danach kommt der Hinweis des Werkzeugs zurueck.
   * `art` faerbt sie: "ok" gruen (etwas ist passiert), "warn" orange (ging
   * nicht), "error" rot (etwas ist schiefgegangen), "info" bleibt grau wie die
   * Hinweise.
   */
  function flash(msg, art = "ok") {
    const box = $("status");
    box.textContent = msg;
    box.className = "status" + (art === "info" ? "" : " status-" + art);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashTimer = null;
      box.textContent = statusHint;
      box.className = "status";
    }, FLASH_MS);
  }

  function setMode(m) {
    builder.setMode(m);
    // "Bauen" steht fuer ALLES, was am Modell arbeitet -- Rohre, Platten,
    // Rutschen, Anbauteile, Klemmen, Verstaerken und den Cursor. Nur der
    // Aufbau-Modus faellt heraus, der hat seinen eigenen Knopf. Vorher fiel die
    // Markierung bei Doppelrohrverbinder/Rohrklammer und beim Verstaerken weg,
    // als waere man aus dem Bauen heraus.
    $("mode-add").classList.toggle("active", m !== "assembly");
    $("mode-select").classList.toggle("active", m === "select");
    $("mode-clamp").classList.toggle("active", m === "clamp");
    $("mode-reinforce").classList.toggle("active", m === "reinforce");
    $("mode-assembly").classList.toggle("active", m === "assembly");
    // Im Aufbau-Modus bleibt die Bauteil-Zeile stehen, aber alles zum Bauen
    // ist ausgegraut -- gebaut wird dort nicht. Die Ansichts-Schalter
    // (Namen, Hinweise, Schnitt, Perspektive) bleiben nutzbar.
    $("toolbar-ctx").hidden = false;
    setzeBauteileGesperrt(m === "assembly");
    // Aufbau-Modus zeigt das Aufbau-Panel; beim Verlassen zurück zum zuletzt
    // gewählten Panel (oder zu). Andere Modi lassen das Panel unberührt.
    if (m === "assembly") {
      // Szene beim Wechsel in den Aufbau-Modus ausblenden.
      // Aufbau-Modus blendet die Szene aus, ohne die Vorliebe zu ueberschreiben.
      applyScene(false, false);
      // Im Hochformat steht der Aufbau als Karte ueber der Szene -- dort waere
      // eine aufspringende Seitenleiste im Weg.
      if (!document.body.classList.contains("sidebar-overlay")) showSidebarPanel("assembly");
    }
    else if (currentPanel === "assembly")
      showSidebarPanel(localStorage.getItem(SIDEBAR_PANEL_KEY) || null);
    applyAssemblySheet();
    updateWakeLock();
    syncPartHighlights();
    syncDeleteButton();
    // Auf dem Touchscreen gibt es kein Strg/Shift -- dort gilt der Hinweis mit
    // dem Halten (siehe _fireLongPress im Builder).
    const statusMap = {
      // Am Finger gibt es kein Strg/Shift, an der Maus kein Halten -- der
      // Hinweis richtet sich nach der zuletzt benutzten Eingabeart.
      select: builder.inputType === "touch" ? "status_select_touch" : "status_select",
      add: "status_add",
      panel: "status_panel",
      reinforce: "status_reinforce",
      clamp: "status_clamp",
      c45: "status_c45",
      fitting: "status_fitting",
      assembly: "status_assembly",
      slide: "status_slide",
    };
    const key = m === "fitting" ? fittingHintKey(builder.fittingKind)
      // Der Auslauf haengt NUR an einem gesetzten Rutschenteil -- fuer ihn gibt
      // es keine Feld-Ankerpunkte, also auch einen eigenen Hinweis. Und was
      // keine Kette fortsetzt (Integralrutsche, Dach), darf auch keine
      // versprechen.
      : m === "slide" && builder.slideKind === "slide-end2" ? "status_slide_end"
      : m === "slide" && !kettenTeil(builder.slideKind) ? "status_slide_solo"
      : (statusMap[m] || "status_add");
    setStatusHint(t(key));
    renderCurrentPart();
    if (m === "assembly") renderAssembly();
  }

  /**
   * Der Hinweis unten links haengt beim Anbauteil an der TEILEART: die
   * Ankerpunkte liegen je nach Teil ganz woanders -- an einem Stutzen, frei auf
   * einem Rohr, am Rohrende oder zwischen zwei Rohren. Ein Sammeltext ("einen
   * Ankerpunkt anklicken") half dort niemandem weiter.
   */
  const FITTING_HINTS = {
    "multi-wheel2": "status_fitting_wheel",
    "floating-wheel2": "status_fitting_tube",
    "hub-cap2": "status_fitting_cap",
    "tube-cap2": "status_fitting_cap",
    "bearing-clamp": "status_fitting_bearing",
    "textil-round2": "status_fitting_round",
    "bag2": "status_fitting_rail",
    "lattice2": "status_fitting_rail",
    "textil2": "status_fitting_rail",
  };
  /** Setzt sich hinter dieses Rutschenteil eine Kette fort? */
  function kettenTeil(kind) {
    return !!(SLIDE_PARTS[kind] && SLIDE_PARTS[kind].chain);
  }

  function fittingHintKey(kind) {
    if (FITTING_HINTS[kind]) return FITTING_HINTS[kind];
    if (HOLE_MASKS[kind]) return "status_fitting_hole";
    // Alles Uebrige sitzt auf einem Stutzen der Kupplung: Radlager, Laufrolle,
    // Arretierung, Adapter, offenes Verbinderende. Weiterdrehen laesst sich nur
    // ein Teil der Truppe -- der Hinweis darf nichts versprechen, was nicht geht.
    return ROTATABLE_FITTINGS.has(kind) ? "status_fitting_arm" : "status_fitting_arm_fixed";
  }

  /**
   * Zeigt oben mittig über der Szene, welches Bauteil gerade gewählt ist --
   * Gegenstück zur Statuszeile unten links. Die Gruppen-Knöpfe in der Leiste
   * tragen nur noch den Gruppennamen, die Variante steht hier.
   */
  function renderCurrentPart() {
    const box = $("current-part");
    if (!box) return;
    let text = null;
    if (builder.mode === "add") {
      const tube = getPartById(builder.tubeId);
      if (tube) text = `${partName(tube)}${builder.diagonal ? " · 45°" : ""}`;
    } else if (builder.mode === "panel") {
      const pan = getPartById(builder.panelId);
      if (pan) text = partName(pan);
    } else if (builder.mode === "slide") {
      text = slideKindName(builder.slideKind);
    } else if (builder.mode === "clamp") {
      const def = allConnectors().find((c) => c.id === builder.clampPart)
        || accessories().find((a) => a.id === builder.clampPart);
      text = def ? partName(def) : null;
    } else if (builder.mode === "fitting") {
      const def = partForFitting(builder.fittingKind);
      text = def ? partName(def) : null;
    } else if (builder.mode === "reinforce") {
      const def = reinforcements()[0];
      text = def ? partName(def) : null;
    }
    box.textContent = text || "";
    box.hidden = !text;
  }

  // Schwarz gibt es nur fuer Platten, nicht fuer Rohre.
  const PANEL_EXTRA_COLORS = [{ id: "black", name: "Schwarz", name_en: "Black", hex: "#2b2b2b" }];

  let activePopup = null;
  let popupAnchor = null; // Button, der das Popup geöffnet hat

  function colorHexFor(colorId) {
    const c = tubeColors().find((x) => x.id === colorId);
    if (c) return c.hex;
    const extra = PANEL_EXTRA_COLORS.find((x) => x.id === colorId);
    return extra ? extra.hex : "#888";
  }

  /** Helligkeit prüfen → braucht dunkle Schrift? */
  function needsDarkInk(hex) {
    if (!hex || hex.length < 7) return false;
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return 0.299 * r + 0.587 * g + 0.114 * b > 0.55;
  }

  /** Aktive Tube/Panel-Buttons in der gewählten Baufarbe einfärben. */
  function syncPartColors() {
    // Zufallsfarbe: es gibt keine Farbe, die der Teile-Button zeigen koennte --
    // also bleibt er neutral.
    const random = builder.color === RANDOM_COLOR;
    const hex = colorHexFor(builder.color);
    // Helle Teilefarbe -> dunkle Schrift. NICHT var(--ink): das kippt im
    // Dunkelmodus ins Helle und stuende dann hell auf gelbem Grund.
    const ink = needsDarkInk(hex) ? "var(--ink-on-part)" : "#fff";
    document.querySelectorAll(".btn.part[data-tube], .btn.part[data-panel]").forEach((b) => {
      if (b.classList.contains("active") && !random) {
        b.style.setProperty("--part-bg", hex);
        b.style.setProperty("--part-ink", ink);
      } else {
        b.style.removeProperty("--part-bg");
        b.style.removeProperty("--part-ink");
      }
    });
  }

  // Manche Popups zeigen KEINE Kopie, sondern die Originalknoten aus der
  // Werkzeugleiste (siehe openGroupPopup). Beim Schliessen muessen die
  // zurueck an ihren Platz, sonst verschwinden sie mit dem Popup.
  let popupCleanup = null;
  // Wann wurde das offene Popup geoeffnet? Ein Tipp auf Touch-Geraeten kann
  // zwei Klick-Ereignisse liefern -- ohne diese Sperre ginge das Popup im
  // selben Wimpernschlag wieder zu.
  let popupOpenedAt = 0;
  const TOGGLE_GUARD_MS = 250;

  /** Zweiter Klick auf denselben Knopf: schliessen -- aber nicht sofort. */
  function togglePopup(anchorBtn) {
    if (!activePopup || popupAnchor !== anchorBtn) return false;
    if (performance.now() - popupOpenedAt > TOGGLE_GUARD_MS) closePopup();
    return true;
  }

  function closePopup() {
    if (!activePopup) return;
    if (popupCleanup) { popupCleanup(); popupCleanup = null; }
    activePopup.remove();
    activePopup = null;
    popupAnchor = null;
    document.removeEventListener("click", onPopupOutsideClick, true);
  }

  function onPopupOutsideClick(e) {
    // Klick auf den Anker-Button selbst (oder dessen Kinder) → Popup bleibt offen;
    // der Button-Handler togglet das Popup dann selbst.
    if (popupAnchor && popupAnchor.contains(e.target)) return;
    if (activePopup && !activePopup.contains(e.target)) closePopup();
  }

  /**
   * Öffnet die Varianten-Liste unter einem Bauteil-Button (Rohre/Platten).
   * Zweiter Klick auf denselben Button schließt sie wieder (Toggle).
   * iconOf(item) liefert das SVG-Markup, onPick(item) übernimmt die Auswahl.
   */
  function showPartPopup(anchorBtn, items, currentId, iconOf, onPick) {
    // Toggle: Popup für denselben Button bereits offen → schließen
    if (togglePopup(anchorBtn)) return;
    closePopup();

    const pop = el("div", "part-popup");
    for (const item of items) {
      const row = el("button", "part-popup-row" + (item.id === currentId ? " active" : ""));
      row.innerHTML = iconOf(item) + `<span class="pp-name"></span>`;
      row.querySelector(".pp-name").textContent = partName(item);
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        onPick(item);
        closePopup();
      });
      pop.appendChild(row);
    }

    document.body.appendChild(pop);
    placePopupUnder(pop, anchorBtn);

    activePopup = pop;
    popupAnchor = anchorBtn;
    popupOpenedAt = performance.now();
    // Leicht verzögert registrieren, damit der auslösende Klick nicht sofort schließt
    // In der CAPTURE-Phase: die Knöpfe der Leiste stoppen das Ereignis, damit
    // sich das eigene Popup nicht sofort wieder schließt. In der Bubble-Phase
    // käme der Schließer deshalb nie an, und eine offene Liste blieb stehen,
    // wenn man daneben etwas anklickt, das gar kein Popup öffnet (Bogenrohr).
    setTimeout(() => document.addEventListener("click", onPopupOutsideClick, true), 0);
  }

  // --- Umhängen (schmale Schirme) ----------------------------------------
  // Wird es eng, wandern ganze Bedien-Gruppen in ein Ausklapp-Panel und später
  // zurück. Verschoben wird immer der ORIGINAL-Knoten: eine zweite Garnitur
  // Knöpfe hätte doppelte IDs, und die Render-Funktionen (renderColorButtons,
  // syncPartHighlights) füllen weiterhin dieselben Container.
  const homeMarks = new WeakMap();

  /** Knoten in `ziel` hängen; `ziel === null` bringt ihn an seinen Platz zurück. */
  function moveNode(node, target) {
    if (!node) return;
    if (target) {
      if (!homeMarks.has(node) && node.parentNode) {
        // Ein Kommentar haelt die Luecke -- sonst ist die Reihenfolge in der
        // Leiste nach dem Zurueckhaengen eine andere.
        const mark = document.createComment("umgehaengt");
        node.parentNode.insertBefore(mark, node);
        homeMarks.set(node, mark);
      }
      if (node.parentNode !== target) target.appendChild(node);
      return;
    }
    const mark = homeMarks.get(node);
    if (mark && mark.parentNode) mark.parentNode.insertBefore(node, mark);
  }

  /**
   * Popup, das eine vorhandene Gruppe zeigt (Farben, Ansichts-Schalter).
   * Beim Schliessen wandert sie an ihren Platz in der Leiste zurueck.
   */
  function openGroupPopup(anchorBtn, group, cls) {
    if (togglePopup(anchorBtn)) return;
    closePopup();
    const pop = el("div", `part-popup ${cls}`);
    document.body.appendChild(pop);
    // Waehrend die Gruppe im Popup haengt, ruht die Messung: sonst meldet die
    // Leiste "passt wieder", schaltet eine Stufe zurueck -- und das Zurueck-
    // schalten schliesst das gerade geoeffnete Popup.
    measurePaused = true;
    moveNode(group, pop);
    tidyDividers();
    placePopupUnder(pop, anchorBtn);
    activePopup = pop;
    popupAnchor = anchorBtn;
    popupOpenedAt = performance.now();
    popupCleanup = () => {
      moveNode(group, null);
      tidyDividers();
      measurePaused = false;
    };
    setTimeout(() => document.addEventListener("click", onPopupOutsideClick, true), 0);
  }

  /**
   * Popup mit freien Einträgen im Stil der Bauteil-Listen.
   * `entries` sind `{ icon, label, run }` -- `icon` ist fertiges SVG-Markup.
   */
  function showMenuPopup(anchorBtn, entries) {
    if (togglePopup(anchorBtn)) return;
    closePopup();

    const pop = el("div", "part-popup");
    for (const eintrag of entries) {
      const row = el("button", "part-popup-row");
      row.innerHTML = eintrag.icon + `<span class="pp-name"></span>`;
      row.querySelector(".pp-name").textContent = eintrag.label;
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        closePopup();
        eintrag.run();
      });
      pop.appendChild(row);
    }

    document.body.appendChild(pop);
    placePopupUnder(pop, anchorBtn);
    activePopup = pop;
    popupAnchor = anchorBtn;
    popupOpenedAt = performance.now();
    setTimeout(() => document.addEventListener("click", onPopupOutsideClick, true), 0);
  }

  // --- Rohr-Auswahl (Button + Popup) -------------------------------------
  // Frueher stand je Rohrlaenge ein eigener Button in der Leiste; auf schmalen
  // Screens musste die Haelfte davon per hide-narrow verschwinden. Jetzt zeigt
  // EIN Button die aktuelle Wahl, der Klick klappt die Varianten darunter auf.
  // Bogenrohre haben keine gerade Laenge und stehen deshalb nicht in
  // buildableTubes(); gebaut werden sie ueber dieselben Richtungs-Handles und
  // stehen daher mit in der Liste des Rohr-Knopfes.
  const tubeWrap = $("tube-buttons");
  const tubes = buildableTubes();
  const curvedTubes = buildableCurvedTubes();
  // Gerade Laengen und Boegen in EINER Liste -- die Boegen stehen hinten.
  const tubeList = [...tubes, ...curvedTubes];

  function tubeIcon(tube) {
    if (tube.shape === "curved")
      return `<svg viewBox="0 0 28 16" width="28" height="16" aria-hidden="true">` +
        `<path d="M5 14 A9 9 0 0 1 14 5 L23 5" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/></svg>`;
    const w = Math.round(8 + Math.min(tube.length_cm, 75) / 75 * 18);
    return `<svg viewBox="0 0 28 16" width="28" height="16" aria-hidden="true">` +
      `<line x1="${14 - w / 2}" y1="8" x2="${14 + w / 2}" y2="8" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/></svg>`;
  }
  function tubeShortLabel(tube) {
    return tube.shape === "curved" ? t("part_bow") : String(tube.length_cm);
  }

  const tubeBtn = el("button", "btn part");
  tubeBtn.dataset.tube = "";
  tubeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    // Der Gruppen-Knopf klappt nur die Liste auf -- in der Hand liegt erst,
    // was man darin anklickt. Sonst schnappte schon das Nachsehen das zuletzt
    // benutzte Rohr, wie es die uebrigen Gruppen auch nicht tun.
    showPartPopup(tubeBtn, tubeList, builder.tubeId, tubeIcon, (tube) => {
      builder.setTube(tube.id);
      if (builder.mode !== "add") setMode("add");
      else syncPartHighlights();
    });
  });
  tubeWrap.appendChild(tubeBtn);

  // --- Farb-Buttons ------------------------------------------------------
  // Die Farben stehen direkt in der Toolbar. Frueher oeffnete ein zweiter Klick
  // auf einen Teile-Button ein Popup -- schlecht auffindbar und ein Klick, der
  // je nach Zustand etwas anderes tat. Schwarz gilt nur fuer Platten.
  const colorWrap = $("color-buttons");
  function renderColorButtons() {
    if (!colorWrap) return;
    colorWrap.innerHTML = "";
    for (const c of [...tubeColors(), ...PANEL_EXTRA_COLORS]) {
      const sw = el("button", "swatch");
      // Farbe als Variable, nicht als Hintergrund: im Popup faerbt sie nur den
      // Punkt vor dem Namen, in der Leiste den ganzen Knopf.
      sw.style.setProperty("--swatch", c.hex);
      const name = (getLang() === "en" && c.name_en) ? c.name_en : c.name;
      sw.title = name;
      sw.dataset.color = c.id;
      // Im Popup steht der Name daneben; in der Leiste blendet ihn das CSS aus.
      sw.appendChild(el("span", "pp-name", name));
      sw.addEventListener("click", () => {
        builder.setColor(c.id);
        renderColorButtons();
        syncPartColors();
        // Steht die Reihe gerade in einem Popup, ist die Wahl damit erledigt.
        closePopup();
      });
      colorWrap.appendChild(sw);
    }
    // Zufallsfarbe: faerbt jedes neu gesetzte Teil einzeln ein. Steht schon eine
    // Auswahl, wuerfelt ein Klick sie neu -- auch ein zweiter Klick, deshalb
    // ohne die "schon aktiv"-Abkuerzung.
    const rnd = el("button", "swatch swatch-random");
    rnd.title = t("color_random");
    rnd.dataset.color = RANDOM_COLOR;
    rnd.appendChild(el("span", "pp-name", t("color_random")));
    rnd.addEventListener("click", () => {
      builder.setColor(RANDOM_COLOR);
      renderColorButtons();
      syncPartColors();
      closePopup();
    });
    colorWrap.appendChild(rnd);
    colorWrap.querySelectorAll("button").forEach((x) =>
      x.classList.toggle("active", x.dataset.color === builder.color));
    paintColorButton();
  }

  /** Der Ersatz-Knopf (schmale Leiste) traegt die aktuelle Baufarbe. */
  function paintColorButton() {
    const sw = $("btn-color-swatch");
    if (!sw) return;
    const zufall = builder.color === RANDOM_COLOR;
    sw.classList.toggle("swatch-random", zufall);
    sw.style.setProperty("--swatch", zufall ? "transparent" : colorHexFor(builder.color));
  }
  renderColorButtons();

  // --- Platten-Auswahl (Button + Popup) ----------------------------------
  // Analog zu den Rohren. Volle Platte und Lochplatte gleicher Groesse stehen
  // als getrennte Varianten drin und zaehlen in der Stueckliste getrennt; das
  // Icon zeigt das 3x3-Lochraster.
  const panelWrap = $("panel-buttons");
  const panelList = buildablePanels();

  function panelIcon(p) {
    let holes = "";
    if (p.holes === 9)
      for (const cy of [4.6, 8, 11.4])
        for (const cx of [4.6, 8, 11.4])
          holes += `<circle cx="${cx}" cy="${cy}" r="1.35" fill="currentColor"/>`;
    return `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">` +
      `<rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="currentColor" opacity="0.18" stroke="currentColor" stroke-width="1.4"/>` +
      holes + `</svg>`;
  }

  const panelBtn = el("button", "btn part");
  panelBtn.dataset.panel = "";
  panelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    showPartPopup(panelBtn, panelList, builder.panelId, panelIcon, (p) => {
      builder.setPanel(p.id);
      setMode("panel");
    });
  });
  panelWrap.appendChild(panelBtn);

  /** Beschriftet die Bauteil-Buttons mit der jeweils aktuellen Variante. */
  function renderPartButtons() {
    const tube = tubeList.find((x) => x.id === builder.tubeId) || tubes[0];
    // Der Gruppen-Knopf trägt den Gruppennamen, nicht die gewählte Variante --
    // welches Teil in der Hand liegt, steht oben mittig über der Szene.
    tubeBtn.innerHTML = tubeIcon(tube) + `<span></span>`;
    tubeBtn.lastChild.textContent = t("label_tubes");
    tubeBtn.title = `${t("label_tube")}: ${partName(tube)}`;

    const pan = panelList.find((x) => x.id === builder.panelId) || panelList[0];
    panelBtn.innerHTML = panelIcon(pan) + `<span></span>`;
    panelBtn.lastChild.textContent = t("label_panels");
    panelBtn.title = `${t("label_panel")}: ${partName(pan)}`;
  }

  // --- Rutschen-Button ---------------------------------------------------
  // Rutschen sind keine Rohre/Platten: sie werden an zwei senkrechten,
  // parallelen Rohren eingehaengt. Der Modus zeigt die passenden Felder an.
  // --- Rutschen: eine Gruppe mit Klappliste (wie die Anbauteile) ---------
  // Vier Teile: Integralrutsche (steht fuer sich), Modular- und Bogenrutschen-
  // Koerper (lassen sich aneinanderhaengen) und der Auslauf, der eine Kette
  // abschliesst.
  // Je Teil ein eigenes Sinnbild: durchgehende Rutsche, gewellter Modulkoerper,
  // Viertelbogen, Auslauf mit Schnabel. Steht ausserhalb des Knopf-Blocks, weil
  // die Stueckliste dieselben Sinnbilder zeigt.
  const SLIDE_ICONS = {
    "slide-new2": `<path d="M3 13 C7 13 5 4 13 3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`,
    "slide2": `<path d="M3 12 C6 12 6 6 9 6 C11 6 11 4 13 4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`,
    "curved-slide2": `<path d="M13 3 C13 9 9 13 3 13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`,
    "slide-end2": `<path d="M2 11 C6 11 8 6 13 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>` +
      `<path d="M2 11 L2 14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`,
    "roof2": `<path d="M2.5 12 L8 4 L13.5 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  };

  {
    const SLIDE_KINDS = ["slide-new2", "slide2", "curved-slide2", "slide-end2"];
    const items = SLIDE_KINDS.map((k) => {
      const def = partForFitting(k);
      return def ? { ...def, id: k, qdf: k } : null;
    }).filter(Boolean);
    const icon = (item) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">` +
      `${SLIDE_ICONS[(item && item.qdf) || builder.slideKind] || SLIDE_ICONS["slide-new2"]}</svg>`;
    const btn = el("button", "btn part");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      showPartPopup(btn, items, builder.slideKind, icon, (p) => {
        builder.slideKind = p.qdf;
        setMode("slide");
        syncPartHighlights();
      });
    });
    btn.innerHTML = icon() + `<span></span>`;
    btn.lastChild.textContent = t("grp_slides");
    btn.title = t("grp_slides");
    $("slide-buttons").appendChild(btn);
    slideGroupBtn = btn;
  }

  // --- Anbauteile: drei Gruppen mit je einer Klappliste -------------------
  // Geordnet wie am Bauteil gedacht: alles rund ums Rad, alles was Rohre
  // verbindet, und der Rest. Der Doppelrohrverbinder ist kein Anbauteil, er hat
  // einen eigenen Modus -- in der Liste steht er trotzdem bei den Verbindungen.
  const CLAMP_ENTRY = "double_tube";
  const CLIP_ENTRY = "tube_clamp";
  // Die 45-Grad-Winkelkupplung ist ein eigenes Teil: sie steckt auf einem Arm
  // einer Kupplung, das Rohr kommt danach an sie. Eigene QDF-Art hat sie nicht.
  const C45_ENTRY = "c45";
  const FITTING_GROUPS = [
    ["grp_wheels", ["multi-wheel2", "floating-wheel2", "casters2", "bearing2", "hub-cap2", "steering-lock2"],
      `<circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.6"/>` +
      `<circle cx="8" cy="8" r="1.6" fill="currentColor"/>`],
    ["grp_joints", [C45_ENTRY, "bearing-clamp", "hole_1", "hole_2", "hole_t",
      CLAMP_ENTRY, CLIP_ENTRY, "tube-cap2", "open-connector2"],
      `<line x1="2.5" y1="6" x2="13.5" y2="6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>` +
      `<line x1="2.5" y1="11" x2="13.5" y2="11" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>` +
      `<rect x="6" y="3" width="4" height="11" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.3"/>`],
    ["grp_other", ["bag2", "lattice2", "textil2", "textil-round2"],
      `<rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
      `<line x1="2.5" y1="8" x2="13.5" y2="8" stroke="currentColor" stroke-width="1.3"/>`],
  ];
  /**
   * Sinnbild einer Lochzapfenkupplung: der Ring ist ihr LOCH (von der Seite der
   * Lochachse gesehen), die Striche sind ihre Arme -- einer, zwei
   * gegenueberliegende oder drei im T. `arme` ist eine Liste von Strichen
   * [x1,y1,x2,y2]; gezaehlt wird genau so viel, wie das Teil hat.
   */
  const HOLE_ICON = (arme) =>
    arme.map(([x1, y1, x2, y2]) =>
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>`).join("") +
    `<circle cx="8" cy="8" r="3.1" fill="none" stroke="currentColor" stroke-width="1.6"/>`;
  // Die vier moeglichen Arme, jeweils vom Ringrand nach aussen.
  const HOLE_ARM = { rechts: [11.1, 8, 14.6, 8], links: [1.4, 8, 4.9, 8],
    unten: [8, 11.1, 8, 14.6], oben: [8, 1.4, 8, 4.9] };

  // Eigenes Sinnbild je Teil -- vorher trug jede Zeile einer Gruppe dasselbe
  // Gruppen-Icon, in der aufgeklappten Liste war damit nichts zu unterscheiden.
  const FITTING_ICONS = {
    // Räder
    "multi-wheel2": `<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
      `<circle cx="8" cy="8" r="1.5" fill="currentColor"/>` +
      `<path d="M8 2.4 L8 13.6 M2.4 8 L13.6 8 M4 4 L12 12 M12 4 L4 12" stroke="currentColor" stroke-width="0.9"/>`,
    "floating-wheel2": `<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2.6"/>` +
      `<circle cx="8" cy="8" r="1.8" fill="currentColor"/>`,
    "casters2": `<path d="M8 1.6 L8 5.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>` +
      `<path d="M4.4 5.4 L11.6 5.4 L10.4 9 L5.6 9 Z" fill="none" stroke="currentColor" stroke-width="1.3"/>` +
      `<circle cx="8" cy="11.6" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/>`,
    "bearing2": `<rect x="2.2" y="5.2" width="5.6" height="5.6" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/>` +
      `<rect x="7.8" y="6.6" width="6" height="2.8" rx="1.2" fill="currentColor"/>`,
    "hub-cap2": `<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.2"/>` +
      `<circle cx="8" cy="8" r="3" fill="currentColor"/>`,
    "steering-lock2": `<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.2"/>` +
      `<path d="M8 2.6 L8 8 L11.6 9.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>`,
    // Verbindungen
    "c45": `<line x1="2.5" y1="13.5" x2="13.5" y2="2.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>` +
      `<rect x="1.5" y="10.5" width="4" height="4" rx="1" fill="currentColor"/>`,
    "bearing-clamp": `<line x1="1.5" y1="10.5" x2="14.5" y2="10.5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>` +
      `<rect x="5.4" y="7.4" width="5.2" height="6.2" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/>` +
      `<rect x="6.6" y="2.4" width="2.8" height="5.4" rx="1.2" fill="currentColor"/>`,
    // Lochzapfenkupplungen: der Ring sitzt auf dem Stutzen einer Kupplung (der
    // dicke Strich von links), quer dazu stehen ihre eigenen ein bis drei Arme.
    // Der Doppelrohrverbinder darunter hat dagegen ZWEI Ringe nebeneinander --
    // daran sind sie im Menue auseinanderzuhalten.
    "hole_1": HOLE_ICON([HOLE_ARM.rechts]),
    "hole_2": HOLE_ICON([HOLE_ARM.rechts, HOLE_ARM.links]),
    "hole_t": HOLE_ICON([HOLE_ARM.rechts, HOLE_ARM.links, HOLE_ARM.unten]),
    "hole-connector4": HOLE_ICON([HOLE_ARM.rechts]),
    // Doppelrohrverbinder: eine "8" mit den beiden Rohren mittendurch.
    "double_tube": `<line x1="1" y1="5.2" x2="15" y2="5.2" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>` +
      `<line x1="1" y1="10.8" x2="15" y2="10.8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>` +
      `<circle cx="8" cy="5.2" r="3.1" fill="none" stroke="currentColor" stroke-width="1.4"/>` +
      `<circle cx="8" cy="10.8" r="3.1" fill="none" stroke="currentColor" stroke-width="1.4"/>`,
    // Rohrklammer: dieselbe "8", aber oben und unten offen -- zwei "C", die mit
    // dem Rücken aneinanderliegen.
    "tube_clamp": `<line x1="1" y1="5.2" x2="15" y2="5.2" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>` +
      `<line x1="1" y1="10.8" x2="15" y2="10.8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>` +
      `<path d="M5.4 3.5 A3.1 3.1 0 1 0 10.6 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>` +
      `<path d="M5.4 12.5 A3.1 3.1 0 1 1 10.6 12.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`,
    // Rohrkappe: Rohr mit geschlossener Haube am Ende.
    "tube-cap2": `<line x1="1.5" y1="8" x2="9.5" y2="8" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>` +
      `<ellipse cx="11.4" cy="8" rx="2.2" ry="3.4" fill="currentColor"/>`,
    // Offenes Verbinderende: Huelse auf dem Stutzen, beide Enden offen.
    "open-connector2": `<line x1="1.5" y1="8" x2="7" y2="8" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>` +
      `<path d="M7 4.6 L13.4 4.6 M7 11.4 L13.4 11.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>` +
      `<ellipse cx="13.4" cy="8" rx="1.5" ry="3.4" fill="none" stroke="currentColor" stroke-width="1.4"/>`,
    "adapter2": `<path d="M2.4 6.4 L8.6 6.4 L8.6 9.6 L2.4 9.6" fill="none" stroke="currentColor" stroke-width="1.4"/>` +
      `<rect x="8.6" y="4.8" width="5" height="6.4" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4"/>`,
    // Sonstiges
    "bag2": `<path d="M3 4 L13 4 L11.6 13 L4.4 13 Z" fill="none" stroke="currentColor" stroke-width="1.4"/>` +
      `<line x1="3" y1="4" x2="13" y2="4" stroke="currentColor" stroke-width="1.8"/>`,
    "lattice2": `<rect x="2.5" y="4" width="11" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/>` +
      `<path d="M6 4 L6 12 M9.5 4 L9.5 12 M2.5 6.7 L13.5 6.7 M2.5 9.3 L13.5 9.3" stroke="currentColor" stroke-width="0.8"/>`,
    "textil-round2": `<path d="M3 13 L3 8 A8 8 0 0 1 11 13 Z" fill="none" stroke="currentColor" stroke-width="1.4"/>` +
      `<path d="M3 8 A8 8 0 0 1 11 13" fill="none" stroke="currentColor" stroke-width="1.6"/>`,
    "roof-large2": `<path d="M2 12 L8 4 L14 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>` +
      `<line x1="4.4" y1="12" x2="11.6" y2="12" stroke="currentColor" stroke-width="1.2"/>`,
    "textil2": `<path d="M2.5 4 L13.5 4 L13.5 12 L2.5 12 Z" fill="none" stroke="currentColor" stroke-width="1.4"/>` +
      `<path d="M2.5 6.5 C5 5.4 6.5 7.6 8 6.5 C9.5 5.4 11 7.6 13.5 6.5" fill="none" stroke="currentColor" stroke-width="1"/>` +
      `<path d="M2.5 9.5 C5 8.4 6.5 10.6 8 9.5 C9.5 8.4 11 10.6 13.5 9.5" fill="none" stroke="currentColor" stroke-width="1"/>`,
  };
  // --- Sinnbilder der Stueckliste ----------------------------------------
  // Kupplungen: ein Wuerfel in der Mitte, dazu je Arm ein Strich. Waagerecht
  // und senkrecht liegen die Arme in der Bildebene, schraeg gezeichnete zeigen
  // nach vorn/hinten -- so unterscheiden sich Flaechen- und Raumkupplung.
  const connArm = (x, y) =>
    `<line x1="8" y1="8" x2="${x}" y2="${y}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`;
  const connBody = `<rect x="5.6" y="5.6" width="4.8" height="4.8" rx="1.1" fill="currentColor"/>`;
  const connIcon = (...arme) => connBody + arme.join("");
  const CONNECTOR_ICONS = {
    straight: connIcon(connArm(1.5, 8), connArm(14.5, 8)),
    elbow: connIcon(connArm(1.5, 8), connArm(8, 14.5)),
    t: connIcon(connArm(1.5, 8), connArm(14.5, 8), connArm(8, 14.5)),
    cross: connIcon(connArm(1.5, 8), connArm(14.5, 8), connArm(8, 1.5), connArm(8, 14.5)),
    "3way": connIcon(connArm(1.5, 8), connArm(8, 14.5), connArm(13, 3)),
    "4way": connIcon(connArm(1.5, 8), connArm(14.5, 8), connArm(8, 14.5), connArm(13, 3)),
    "5way": connIcon(connArm(1.5, 8), connArm(14.5, 8), connArm(8, 1.5), connArm(8, 14.5), connArm(13, 3)),
    "6way": connIcon(connArm(1.5, 8), connArm(14.5, 8), connArm(8, 1.5), connArm(8, 14.5),
      connArm(13, 3), connArm(3, 13)),
    diagonal: connIcon(connArm(1.5, 8), connArm(13.5, 2.5)),
    // Flexikupplung: zwei Arme um einen Bolzen, frei einstellbar.
    flexi: `<circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
      `<line x1="8" y1="8" x2="1.8" y2="10.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>` +
      `<line x1="8" y1="8" x2="13.5" y2="3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
    flexi_hinge: `<circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
      `<path d="M5.8 8 L2 8 M10.2 8 L14 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
    flexi_bolt: `<circle cx="4.4" cy="8" r="2.6" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
      `<line x1="7" y1="8" x2="14" y2="8" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>`,
  };
  // Verstaerkungsprofil: Rohr im Schnitt mit dem Holz-Profil darin -- dasselbe
  // Sinnbild wie am Knopf "Verstärken".
  const REINFORCE_ICON = `<rect x="1.6" y="4.8" width="12.8" height="6.4" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.3"/>` +
    `<line x1="4" y1="8" x2="12" y2="8" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>`;
  // Schraube: Kopf mit Schlitz und Gewinde.
  const SCREW_ICON = `<circle cx="4.2" cy="8" r="2.8" fill="none" stroke="currentColor" stroke-width="1.4"/>` +
    `<line x1="4.2" y1="6" x2="4.2" y2="10" stroke="currentColor" stroke-width="1.2"/>` +
    `<path d="M7 8 L14 8 M8.4 6.2 L8.4 9.8 M10.4 6.2 L10.4 9.8 M12.4 6.2 L12.4 9.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`;
  // Sicherungsklammer: Haken, der das Rohr am Boden haelt.
  const CLAMP_ANCHOR_ICON = `<path d="M4.4 3 L4.4 9.6 A3.6 3.6 0 0 0 11.6 9.6 L11.6 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>` +
    `<line x1="1.6" y1="13.4" x2="14.4" y2="13.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`;
  // Poolfolie: die Wanne im Schnitt, mit Wasserlinie.
  const POOL_ICON = `<path d="M2.5 4 L2.5 12.5 L13.5 12.5 L13.5 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>` +
    `<path d="M3.5 8.5 C5.2 7.4 6.6 9.6 8.2 8.5 C9.8 7.4 11.2 9.6 12.8 8.5" fill="none" stroke="currentColor" stroke-width="1"/>`;
  const svg16 = (inner) =>
    `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${inner}</svg>`;

  /** Sinnbild für eine Zeile der Stückliste -- dasselbe wie an den Knöpfen. */
  function bomIcon(gruppe, id, kind) {
    if (gruppe === "tubes") { const d = getTube(id); return d ? tubeIcon(d) : null; }
    if (gruppe === "panels") { const d = getPanel(id); return d ? panelIcon(d) : null; }
    if (gruppe === "connectors") return svg16(teileIcon(id, null)) ;
    if (gruppe === "slides") return svg16(SLIDE_ICONS[kind || id] || SLIDE_ICONS["slide-new2"]);
    if (gruppe === "textiles") return svg16(FITTING_ICONS["textil2"]);
    if (gruppe === "reinforcements") return svg16(REINFORCE_ICON);
    if (gruppe === "screws") return svg16(SCREW_ICON);
    if (gruppe === "fittings") {
      // Die Poolfolie hat keine eigene QDF-Art -- sie haengt am Bällebad und
      // steht im Katalog mit ihren Maßen (`pool`).
      const def = id ? getPartById(id) : null;
      if ((kind && POOL_KINDS.has(kind)) || (def && def.pool)) return svg16(POOL_ICON);
      if (id === "safety_clamp") return svg16(CLAMP_ANCHOR_ICON);
      const inner = teileIcon(id, kind);
      return inner ? svg16(inner) : null;
    }
    return null;
  }

  // Manche Teile führen ihr Sinnbild unter der QDF-Art, andere unter der
  // Teile-Kennung; die Klemm-Kupplungen teilen sich eins mit den Anbauteilen.
  const ICON_ALIAS = { bearing: "bearing-clamp", tube_cap: "tube-cap2",
    open_end: "open-connector2" };
  function teileIcon(id, kind) {
    return FITTING_ICONS[kind] || SLIDE_ICONS[kind] || CONNECTOR_ICONS[id]
      || FITTING_ICONS[id] || FITTING_ICONS[ICON_ALIAS[id]] || null;
  }

  const fittingGroupBtns = [];
  for (const [key, kinds, path] of FITTING_GROUPS) {
    const items = kinds.map((k) => {
      // Klemmen und Lochzapfenkupplungen stehen unter ihrer Katalog-Kennung im
      // Menue, die uebrigen unter ihrer QDF-Art.
      const def = (k === CLAMP_ENTRY || k === CLIP_ENTRY || HOLE_MASKS[k])
        ? allConnectors().find((c) => c.id === k)
        : k === C45_ENTRY ? allConnectors().find((c) => c.id === "diagonal")
        : partForFitting(k);
      return def ? { ...def, id: k, qdf: k } : null;
    }).filter(Boolean);
    if (!items.length) continue;
    // Der Gruppen-Knopf trägt das Gruppen-Sinnbild, jede Zeile der Liste ihr
    // eigenes.
    const icon = (item) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">` +
      `${(item && FITTING_ICONS[item.qdf]) || path}</svg>`;
    const btn = el("button", "btn part");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const gewaehlt = builder.mode === "clamp" ? builder.clampPart
        : builder.mode === "c45" ? C45_ENTRY : builder.fittingKind;
      showPartPopup(btn, items, gewaehlt, icon, (p) => {
        if (p.qdf === C45_ENTRY) { setMode("c45"); return; }
        if (p.qdf === CLAMP_ENTRY || p.qdf === CLIP_ENTRY) {
          builder.setClampPart(p.qdf);
          setMode("clamp");
          return;
        }
        builder.setFitting(p.qdf);
        setMode("fitting");      // setzt auch den Hinweis zur gewaehlten Teileart
      });
    });
    btn.innerHTML = icon() + `<span></span>`;
    btn.lastChild.textContent = t(key);
    btn.title = t(key);
    $("fitting-buttons").appendChild(btn);
    fittingGroupBtns.push({ btn, kinds, key });
  }
  renderFittingButton = () => {
    for (const g of fittingGroupBtns) {
      const aktiv = (builder.mode === "fitting" && g.kinds.includes(builder.fittingKind))
        || (builder.mode === "clamp" && g.kinds.includes(builder.clampPart))
        || (builder.mode === "c45" && g.kinds.includes(C45_ENTRY));
      g.btn.classList.toggle("active", aktiv);
      g.btn.lastChild.textContent = t(g.key);
      g.btn.title = t(g.key);          // sonst bliebe der Tooltip in der alten Sprache
    }
  };
  renderFittingButton();

  // --- Aktionen ----------------------------------------------------------
  $("btn-undo").addEventListener("click", () => builder.undo());
  $("btn-redo").addEventListener("click", () => builder.redo());
  const camBtn = $("btn-camera");
  if (camBtn) camBtn.addEventListener("click", () => scene.resetCamera(model));
  /** Ein Modell als QDF anbieten. `daten` ist ein Modell-JSON. */
  function exportiereModell(name, daten) {
    const m2 = new (model.constructor)();
    m2.loadJSON(daten);
    const { text, stats } = buildQDF(m2);
    storage.exportText(text, `${dateiName(name)}.qdf`);
    const parts = `${stats.connectors} + ${stats.tubes + stats.bows} + ${stats.panels}`;
    flash(t("flash_exported_qdf", parts));
  }

  /** Das gerade offene Modell als QDF sichern (Strg/Cmd+E). */
  function exportActiveTab() {
    const tab = ui.captureActiveTab();
    if (!tab) return;
    exportiereModell(tab.name, tab.model);
  }

  /** Aus einem Entwurfsnamen einen brauchbaren Dateinamen machen. */
  function dateiName(name) {
    return (name || "quadro").replace(/[\\/:*?"<>|]/g, "-").trim() || "quadro";
  }

  // Alle Modelle auf einmal: mit Ordner-Auswahl (Chrome/Edge) in einen Rutsch,
  // sonst nacheinander als einzelne Downloads.
  $("btn-export-all").addEventListener("click", async () => {
    toggleFileMenu(false);
    ui.captureActiveTab();
    let liste = [];
    try { liste = await docs.listDocs(); } catch (e) { console.warn("Dateien:", e); }
    // Offene, noch nicht gespeicherte Tabs kommen mit ihrem Arbeitsstand dazu.
    const alle = liste.map((d) => ({ name: d.name, data: d.data }));
    for (const tab of tabs) {
      if (tab.docId && !tab.dirty) continue;
      const i = alle.findIndex((x) => x.name === tab.name);
      const eintrag = { name: tab.name, data: tab.model };
      if (i >= 0) alle[i] = eintrag; else alle.push(eintrag);
    }
    if (!alle.length) { flash(t("flash_export_all_empty"), "warn"); return; }
    const texte = alle.map((d) => {
      const m2 = new (model.constructor)();
      m2.loadJSON(d.data);
      return { name: dateiName(d.name), text: buildQDF(m2).text };
    });

    if (window.showDirectoryPicker) {
      try {
        const ordner = await window.showDirectoryPicker({ mode: "readwrite" });
        for (const f of texte) {
          const handle = await ordner.getFileHandle(`${f.name}.qdf`, { create: true });
          const w = await handle.createWritable();
          await w.write(f.text);
          await w.close();
        }
        flash(t("flash_exported_all", texte.length));
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;      // Dialog abgebrochen
        console.warn("Ordner-Export:", e);
      }
    }
    for (const f of texte) storage.exportText(f.text, `${f.name}.qdf`);
    flash(t("flash_exported_all", texte.length));
  });

  $("own-import").addEventListener("click", () => $("file-import").click());

  /** Eine QDF- oder JSON-Datei einlesen. Liefert { daten, info }. */
  async function leseModellDatei(f) {
    if (!/\.qdf$/i.test(f.name)) {
      return { daten: await storage.importFile(f), info: t("flash_imported_json") };
    }
    const text = await f.text();
    const data = parseQDF(text, {
      tubes: buildableTubes(),
      panels: panels(),
      connectorSize: geometry().connectorSize,
      mergeEps: 2,
    });
    if (!data.nodes.length) throw new Error(t("qdf_no_parts"));
    const st = data.stats;
    const skip = Object.entries(st.skipped || {});
    const skipTxt = skip.length
      ? t("qdf_skipped", skip.map(([k, v]) => `${v}× ${k.replace(/2$|-new2$|-end2$/, "")}`).join(", "))
      : "";
    const panelTxt = st.panels ? `, ${st.panels} ${t("bom_panels").toLowerCase()}` : "";
    const clampTxt = st.clamps ? `, ${st.clamps} ${t("btn_clamp").toLowerCase()}` : "";
    const stats = `${st.nodes} ${t("bom_connectors").split(" ")[0].toLowerCase()}, ${st.tubes} ${t("bom_tubes").toLowerCase()}${panelTxt}${clampTxt}`;
    return { daten: data, info: t("qdf_imported", stats, skipTxt) };
  }

  $("file-import").addEventListener("change", async (e) => {
    // FileList ist LEBENDIG: erst kopieren, dann das Feld freigeben -- sonst
    // laesst sich dieselbe Datei kein zweites Mal waehlen.
    const dateien = [...e.target.files];
    e.target.value = "";
    if (!dateien.length) return;

    // Jede Datei bekommt einen EIGENEN Tab; offene Modelle bleiben stehen.
    // Eine kaputte Datei bricht den Rest nicht ab, sie wird am Ende gemeldet.
    const fehler = [];
    let geladen = 0, letzteInfo = "";
    for (const f of dateien) {
      try {
        const { daten, info } = await leseModellDatei(f);
        const name = f.name.replace(/\.[^.]+$/, "").trim() || t("doc_untitled");
        openTab({ name, data: daten });
        geladen++;
        letzteInfo = info;
      } catch (err) {
        fehler.push(`${f.name}: ${err.message}`);
      }
    }
    if (geladen) {
      scene.resetCamera(model);
      flash(geladen === 1 ? letzteInfo : t("flash_imported_n", geladen));
    }
    if (fehler.length) showMessage(fehler.join("\n"));
  });

  // --- Dateien: Neu, Öffnen, Speichern, Speichern unter ------------------
  // Ein Tab zeigt entweder eine gespeicherte Datei (docId gesetzt) oder einen
  // noch namenlosen Stand. Gespeichert wird in dieselbe Datei; "Speichern
  // unter" legt eine neue an.
  const AUTOSAVE_MODE_KEY = "quadro.autosaveMode.v1";
  let autosaveOn = localStorage.getItem(AUTOSAVE_MODE_KEY) !== "0";
  let docSaveTimer = null;

  function isAutosaveOn() { return autosaveOn; }
  function setAutosaveOn(on) {
    autosaveOn = !!on;
    localStorage.setItem(AUTOSAVE_MODE_KEY, autosaveOn ? "1" : "0");
    if (autosaveOn) scheduleDocSave();
  }

  async function refreshDocList() {
    // Die Kopfzeile hat keine Auswahlliste mehr -- die Modelle stehen in der
    // Seitenleiste. Bleibt für den Fall, dass die Liste wieder auftaucht.
    const sel = $("doc-select");
    if (!sel) { if (currentPanel === "own") renderOwnModels(); return; }
    const alt = sel.value;
    sel.innerHTML = "";
    let liste = [];
    try { liste = await docs.listDocs(); } catch (e) { console.warn("Dateien:", e); }
    if (!liste.length) {
      const o = el("option", null, t("saves_empty"));
      o.value = ""; sel.appendChild(o);
      return;
    }
    for (const d of liste) {
      const o = el("option", null, d.name); o.value = d.id; sel.appendChild(o);
    }
    if (alt && liste.some((d) => d.id === alt)) sel.value = alt;
  }

  /**
   * Namen abfragen und auf Kollision prüfen. Liefert { name, doc } -- `doc` ist
   * die vorhandene Datei, wenn überschrieben werden soll -- oder null bei
   * Abbruch.
   */
  async function askName(vorschlag, { eigeneId = null } = {}) {
    const name = await askInput(t("prompt_save_name"), vorschlag || "", { title: t("dlg_name_title"), ok: t("ask_save") });
    if (!name) return null;
    const vorhanden = await docs.docByName(name);
    if (vorhanden && vorhanden.id !== eigeneId) {
      if (!(await askConfirm(t("confirm_overwrite", name), { title: t("dlg_overwrite_title"), ok: t("dlg_overwrite_ok") }))) return null;
      return { name, doc: vorhanden };
    }
    return { name, doc: null };
  }

  /** Laufenden Tab in seine Datei schreiben (oder in eine neue). */
  async function saveActiveTab({ name = null, docId = undefined, nurBeiAenderung = false } = {}) {
    const tab = ui.captureActiveTab();
    if (!tab) return null;
    const ziel = docId !== undefined ? docId : tab.docId;
    // Automatisches Speichern soll das Datum nur anfassen, wenn sich am Modell
    // wirklich etwas geändert hat -- sonst rutscht eine Datei allein durchs
    // Öffnen in der Liste nach oben.
    if (nurBeiAenderung && ziel) {
      const alt = await docs.getDoc(ziel);
      if (alt && JSON.stringify(alt.data) === JSON.stringify(tab.model)) {
        tab.dirty = false;
        tab.savedJson = JSON.stringify(tab.model);
        renderTabs();
        // Auch die Sitzung muss die Marke loswerden, sonst zeigt der Tab nach
        // einem Reload den Änderungs-Punkt, obwohl nichts offen ist.
        scheduleSessionSave();
        return alt;
      }
    }
    try {
      const doc = await docs.saveDoc({ docId: ziel, name: name || tab.name, data: tab.model });
      tab.docId = doc.id;
      tab.name = doc.name;
      tab.dirty = false;
      tab.savedJson = JSON.stringify(tab.model);
      tab.preview = false;
      renderTabs();
      refreshDocList();
      scheduleSessionSave();
      sync.nudge();
      return doc;
    } catch (e) {
      flash(t("flash_save_failed", e.message), "error");
      return null;
    }
  }

  function scheduleDocSave() {
    if (!autosaveOn) return;
    // Hängt eine Kopie am Zeiger, wird nicht gespeichert: sie steckt zwar im
    // Modell, gehört aber noch niemandem. Nach dem Absetzen oder Abbrechen
    // meldet sich die nächste Änderung ohnehin wieder.
    if (builder.pasting) return;
    clearTimeout(docSaveTimer);
    docSaveTimer = setTimeout(() => {
      const tab = activeTab();
      if (tab && tab.dirty) saveActiveTab({ nurBeiAenderung: true });
    }, 800);
  }

  // Ein neues Modell heißt erst einmal "Unbenannt" und gehört zu keiner Datei.
  // Nach dem Namen wird gefragt, wenn gespeichert wird -- nicht vorher.
  $("btn-doc-new").addEventListener("click", () => { openTab({ name: freierName() }); });

  // Datei-Menü: die Einträge lösen die (versteckten) Knöpfe aus, an denen die
  // Logik hängt -- so gibt es jede Aktion genau einmal.
  const DATEI_ICONS = {
    neu: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">
            <path d="M3.5 1.5h5l4 4v9h-9z"/><path d="M8.5 1.5v4h4"/><path d="M8 8v4M6 10h4"/></svg>`,
    oeffnen: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">
            <path d="M1.5 12.5v-9h4l1.5 2h7.5v7z"/></svg>`,
    speichern: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">
            <path d="M2 2h9l3 3v9H2z"/><path d="M5 2v4h5V2"/><rect x="4.5" y="9" width="7" height="5"/></svg>`,
    speichernUnter: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">
            <path d="M2 2h8l3 3v4"/><path d="M2 2v12h5"/><path d="M5 2v3.5h4V2"/>
            <path d="M14.2 10.6 10 14.8l-2 .5.5-2 4.2-4.2z"/></svg>`,
    export: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">
            <path d="M8 1.8v8.4"/><path d="M4.8 7 8 10.4 11.2 7"/><path d="M2.5 12.5v1.7h11v-1.7"/></svg>`,
    import: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">
            <path d="M8 10.2V1.8"/><path d="M4.8 5 8 1.6 11.2 5"/><path d="M2.5 12.5v1.7h11v-1.7"/></svg>`,
  };
  /** Die Einträge des Datei-Menüs -- als Popup und als Zeilen im Hauptmenü. */
  function fileEntries() {
    return [
      { icon: DATEI_ICONS.neu, label: t("btn_doc_new"), run: () => $("btn-doc-new").click() },
      { icon: DATEI_ICONS.oeffnen, label: t("btn_doc_open"), run: () => $("btn-doc-open").click() },
      { icon: DATEI_ICONS.speichern, label: t("btn_doc_save"), run: () => $("btn-doc-save").click() },
      { icon: DATEI_ICONS.speichernUnter, label: t("btn_doc_saveas"), run: () => $("btn-doc-saveas").click() },
      { icon: DATEI_ICONS.import, label: t("btn_import"), run: () => $("file-import").click() },
      { icon: DATEI_ICONS.export, label: t("btn_export_qdf"), run: () => exportActiveTab() },
    ];
  }

  $("btn-file-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    showMenuPopup($("btn-file-menu"), fileEntries());
  });

  /**
   * Im Hochformat gibt es keinen eigenen Datei-Knopf mehr: seine Eintraege
   * stehen als Zeilen oben im Hauptmenue, das auch die Marke oeffnet.
   */
  function renderMenuFileRows(on) {
    const box = $("menu-file-rows");
    box.innerHTML = "";
    box.hidden = !on;
    if (!on) return;
    for (const eintrag of fileEntries()) {
      const row = el("button", "part-popup-row");
      row.innerHTML = eintrag.icon + `<span class="pp-name"></span>`;
      row.querySelector(".pp-name").textContent = eintrag.label;
      row.addEventListener("click", () => { toggleHamburger(false); eintrag.run(); });
      box.appendChild(row);
    }
  }

  // "Öffnen" hat keine eigene Liste mehr: es zeigt den Seitenleisten-Tab
  // "Meine Modelle", dort steht jedes Modell mit Öffnen, Umbenennen, Löschen.
  $("btn-doc-open").addEventListener("click", () => {
    showSidebarPanel("own");
    renderOwnModels();
  });

  // --- Abgleich mit dem Server -------------------------------------------
  // Der Speicher im Browser bleibt der Arbeitsbestand; sync.js hält ihn mit dem
  // Server im Gleichklang und meldet sich hier, sobald sich dort etwas getan
  // hat. Ohne Backend passiert in diesem Abschnitt schlicht nichts.

  /** Serverstand in einen offenen Tab übernehmen. */
  function applyRemoteToTab(tab, doc) {
    tab.name = doc.name;
    tab.model = doc.data;
    tab.dirty = false;
    tab.savedJson = JSON.stringify(doc.data);
    if (tab.tabId === activeTabId) {
      const camera = scene.cameraState();
      ladeVorgang = true;
      builder.modelReplaced();
      model.loadJSON(doc.data || { format: 1, nodes: [], tubes: [] });
      // Die Schrittspeicher gehören zum alten Inhalt -- der neue kommt von
      // woanders, dahin führt kein Rückgängig.
      builder.clearHistory();
      builder.refresh();
      if (camera) scene.restoreCameraState(camera);
      ladeVorgang = false;
      update();
    } else {
      tab.view = { ...(tab.view || {}), undo: [], redo: [] };
    }
    renderTabs();
    scheduleSessionSave();
  }

  /** Eine Datei wurde anderswo gespeichert und liegt jetzt frisch im Speicher. */
  async function onDocUpdated(doc) {
    if (currentPanel === "own") renderOwnModels();
    // Ein Serverstand ersetzt das ganze Modell -- eine Kopie am Zeiger würde
    // dabei zu Teilen ohne Zuhause. Also vorher abräumen.
    builder.cancelPaste();
    const tab = tabs.find((x) => x.docId === doc.id);
    if (!tab) return;
    if (!tab.dirty) {
      applyRemoteToTab(tab, doc);
      flash(t("sync_doc_updated", doc.name), "info");
      return;
    }
    const answer = await queueDialog(() => dialog({
      title: t("sync_remote_title"),
      text: t("sync_remote_text", doc.name),
      cancelKey: "keep",
      buttons: [
        { key: "load", label: t("sync_take_server") },
        { key: "keep", label: t("sync_keep_local"), kind: "ghost" },
      ],
    }));
    if (answer && answer.key === "load") applyRemoteToTab(tab, doc);
  }

  /** Eine Datei ist anderswo gelöscht worden. */
  function onDocRemoved(docId) {
    for (const tab of tabs) {
      if (tab.docId !== docId) continue;
      tab.docId = null;
      tab.dirty = true;
      tab.savedJson = null;
      flash(t("sync_doc_removed", tab.name), "info");
    }
    renderTabs();
    if (currentPanel === "own") renderOwnModels();
  }

  /**
   * Echter Konflikt: beide Seiten haben dieselbe Datei angefasst. Nur hier
   * wird gefragt -- alles andere gleicht sich still ab.
   */
  async function onSyncConflict({ kind, local, server }) {
    const name = (local && local.name) || (server && server.name) || "";
    const texts = {
      both: [t("sync_conflict_text", name), t("sync_take_server"), t("sync_take_local")],
      "deleted-remote": [t("sync_gone_text", name), t("sync_delete_here"), t("sync_upload_again")],
      "deleted-local": [t("sync_kept_text", name), t("sync_restore"), t("sync_delete_there")],
      inventory: [t("sync_inv_conflict"), t("sync_take_server"), t("sync_take_local")],
    };
    const [text, serverLabel, localLabel] = texts[kind] || texts.both;
    const answer = await queueDialog(() => dialog({
      title: t("sync_conflict_title"),
      text,
      cancelKey: "later",
      buttons: [
        { key: "server", label: serverLabel },
        { key: "local", label: localLabel },
        { key: "later", label: t("sync_later"), kind: "ghost" },
      ],
    }));
    return answer ? answer.key : "later";
  }

  /** Zustandszeile in den Einstellungen (und Meldung beim Wechsel). */
  let lastSyncState = null;
  let lastSyncInfo = { pending: 0, lastSyncAt: 0 };
  let serverSeen = false;          // stand die Verbindung in dieser Sitzung schon?

  /**
   * Zustandszeile schreiben. Getrennt vom Rückruf, damit sie auch ein
   * Sprachwechsel neu setzen kann -- ihr Text steht nicht im HTML und wird
   * deshalb von applyTranslations() nicht erwischt.
   */
  function renderSyncLine() {
    const line = $("sync-state");
    if (!line) return;
    // Ohne Server steht dort nichts -- die App verhält sich dann wie immer,
    // und ein "kein Server" wäre nur eine Meldung über eine Nicht-Funktion.
    // Erst wenn eine Verbindung bestand, ist ihr Zustand eine Nachricht wert.
    line.hidden = !serverSeen;
    if (!serverSeen) return;
    const when = lastSyncInfo.lastSyncAt
      ? new Date(lastSyncInfo.lastSyncAt).toLocaleTimeString(locale()) : "–";
    line.textContent = lastSyncState === "online" ? t("sync_state_online", when)
      : lastSyncState === "connecting" ? t("sync_state_connecting")
      : t("sync_state_offline", lastSyncInfo.pending);
    line.classList.toggle("sync-off", lastSyncState !== "online");
  }

  function onSyncStatus(state, { pending, lastSyncAt }) {
    if (state === "online") serverSeen = true;
    const previous = lastSyncState;
    lastSyncState = state;
    lastSyncInfo = { pending, lastSyncAt };
    renderSyncLine();
    if (previous && state !== previous && state !== "connecting") {
      if (state === "offline") flash(t("sync_lost"), "error");
      else if (state === "online" && previous === "offline") flash(t("sync_back"), "info");
    }
  }

  /** Bestand kam vom Server: in das laufende Objekt übernehmen und neu zeichnen. */
  function onInventoryUpdated(data) {
    // Das Objekt selbst bleibt -- an ihm hängen Stückliste und Machbarkeit.
    for (const key of Object.keys(inventory)) delete inventory[key];
    Object.assign(inventory, {
      tubes: data.tubes || {}, connectors: data.connectors || {},
      panels: data.panels || {}, reinforcements: data.reinforcements || {},
      fittings: data.fittings || {},
    });
    update();
    if (currentPanel === "library") renderLibrary();
    flash(t("sync_inv_updated"), "info");
  }

  sync.configure({
    onStatus: (state, info) => { renderLibHint(); onSyncStatus(state, info); },
    onDocUpdated,
    onDocRemoved,
    onConflict: onSyncConflict,
    onLibChanged: () => { loadLibrary(); },
    onInventoryUpdated,
  });

  /**
   * Datei in einem Tab öffnen -- ist sie schon offen, wird der Tab gewählt.
   * `preview` öffnet sie nur zum Ansehen: der nächste Vorschau-Klick ersetzt
   * den Tab wieder (siehe discardPreview).
   */
  async function openDocById(docId, { preview = false } = {}) {
    const offen = tabs.find((x) => x.docId === docId);
    if (offen) {
      activateTab(offen.tabId);
      if (!preview) pinTab(offen);
      return offen;
    }
    const doc = await docs.getDoc(docId);
    if (!doc) { flash(t("load_error_data"), "error"); return null; }
    const tab = openTab({ name: doc.name, data: doc.data, docId: doc.id, preview });
    flash(t("flash_loaded", doc.name));
    return tab;
  }


  $("btn-doc-save").addEventListener("click", async () => {
    const tab = ui.activeTab;
    if (!tab) return;
    toggleFileMenu(false);
    if (!tab.docId) {
      const gewaehlt = await askName(tab.name);
      if (!gewaehlt) return;
      await saveActiveTab({ name: gewaehlt.name, docId: gewaehlt.doc ? gewaehlt.doc.id : null });
    } else {
      await saveActiveTab();
    }
    flash(t("flash_saved", ui.activeTab.name));
  });

  $("btn-doc-saveas").addEventListener("click", async () => {
    const tab = ui.activeTab;
    if (!tab) return;
    const gewaehlt = await askName(tab.name);
    if (!gewaehlt) return;
    toggleFileMenu(false);
    await saveActiveTab({ name: gewaehlt.name, docId: gewaehlt.doc ? gewaehlt.doc.id : null });
    flash(t("flash_saved", gewaehlt.name));
  });

  // --- Hilfe-Overlay -----------------------------------------------------
  $("btn-help").addEventListener("click", () => { $("help-overlay").hidden = false; });
  $("help-close").addEventListener("click", () => { $("help-overlay").hidden = true; });
  // Klick daneben schliesst die Liste -- wie bei der Rückfrage-Karte.
  $("help-overlay").addEventListener("mousedown", (e) => {
    if (e.target === $("help-overlay")) $("help-overlay").hidden = true;
  });

  // --- Modell-Bibliothek -------------------------------------------------
  // Eigene QDF-Sammlung: einmal einlesen, danach durchsuchen, gegen den
  // Bestand filtern und mit einem Klick oeffnen. Die Dateien liegen in
  // IndexedDB (localStorage waere mit ~3 MB Sammlung zu klein).
  let libEntries = [];        // { id, name, file, qdf, meta }
  let libLoaded = false;

  function libStatus(msg) { $("lib-status").textContent = msg || ""; }

  /**
   * Wohin die eingelesenen Dateien gehen. Ohne Server bleiben sie im Browser --
   * mit Server wandern sie dorthin, und dann wäre der alte Satz schlicht falsch.
   */
  function renderLibHint() {
    const box = $("lib-hint-where");
    if (box) box.textContent = t(sync.enabled() ? "lib_hint_server" : "lib_hint_local");
  }

  async function loadLibrary() {
    try {
      libEntries = await storage.libAll();
    } catch (e) {
      console.warn("Bibliothek nicht lesbar:", e);
      libEntries = [];
    }
    libLoaded = true;
    renderLibrary();
  }

  // Dateien einlesen. Laeuft in Haeppchen, damit die Oberflaeche bei einem
  // ganzen Ordner (mehrere hundert Dateien) nicht einfriert.
  async function addToLibrary(fileList) {
    const files = [...fileList].filter((f) => /\.qdf$/i.test(f.name));
    if (!files.length) return;
    const fresh = [];
    let skipped = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (i % 10 === 0) {
        libStatus(t("lib_reading", i, files.length));
        await new Promise((r) => setTimeout(r, 0));
      }
      let entry = null;
      try {
        entry = designEntry(`${f.name}|${f.size}`, f.name, await f.text());
      } catch (err) {
        console.warn("QDF nicht lesbar:", f.name, err);
      }
      if (entry) fresh.push(entry); else skipped++;
    }
    if (fresh.length) {
      try {
        await storage.libPut(fresh);
        sync.nudge();
      } catch (e) {
        console.warn("Bibliothek nicht speicherbar:", e);
      }
    }
    await loadLibrary();
    libStatus(t("lib_added", fresh.length, skipped));
    flash(t("lib_added", fresh.length, skipped));
  }

  // --- Bibliothek sortieren ----------------------------------------------
  // Je Kriterium eine Zahl (oder ein Name); die Richtung dreht nur das
  // Vorzeichen. Gewaehlte Sortierung und Richtung ueberleben den Reload -- sie
  // gehoeren zum Arbeitsstand, nicht zu den Dateien.
  const LIB_SORT_KEY = "quadro.libSort.v1";
  const LIB_SORTS = {
    name: "lib_sort_name",
    missing: "lib_sort_missing",
    tubes: "lib_sort_tubes",
    panels: "lib_sort_panels",
    volume: "lib_sort_volume",
  };
  let libSort = "name";
  let libSortDesc = false;
  try {
    const gespeichert = JSON.parse(localStorage.getItem(LIB_SORT_KEY)) || {};
    if (LIB_SORTS[gespeichert.by]) libSort = gespeichert.by;
    libSortDesc = !!gespeichert.desc;
  } catch { /* nichts gemerkt */ }

  /** Der Wert, nach dem sortiert wird -- bei "name" ein Text, sonst eine Zahl. */
  function libSortWert(zeile, art) {
    const m = zeile.entry.meta;
    if (art === "missing") return missingCount(zeile.check);
    if (art === "tubes") return m.tubes || 0;
    if (art === "panels") return m.panels || 0;
    // Volumen der Aussenmasse in Kubikmetern -- die Zahl ist nur zum Vergleichen
    // da, deshalb ungerundet.
    if (art === "volume") return ((m.size[0] || 0) * (m.size[1] || 0) * (m.size[2] || 0)) / 1e6;
    return zeile.entry.name;
  }

  function libVisible() {
    const q = $("lib-search").value.trim().toLowerCase();
    const onlyFeasible = $("lib-only-feasible").checked;
    const rows = [];
    for (const e of libEntries) {
      if (q && !e.name.toLowerCase().includes(q)) continue;
      const check = checkAgainstInventory(e.meta, inventory);
      if (onlyFeasible && !check.ok) continue;
      rows.push({ entry: e, check });
    }
    const richtung = libSortDesc ? -1 : 1;
    rows.sort((a, b) => {
      const va = libSortWert(a, libSort), vb = libSortWert(b, libSort);
      if (typeof va === "string") return richtung * va.localeCompare(vb, locale());
      // Gleichstand (viele Modelle brauchen dieselbe Zahl Rohre): nach Namen,
      // damit die Liste nicht bei jedem Neuzeichnen anders steht.
      if (va !== vb) return richtung * (va - vb);
      return a.entry.name.localeCompare(b.entry.name, locale());
    });
    return rows;
  }

  function renderLibSort() {
    const sel = $("lib-sort");
    const knopf = $("lib-sort-dir");
    if (!sel || !knopf) return;
    sel.innerHTML = "";
    for (const [wert, key] of Object.entries(LIB_SORTS)) {
      const o = document.createElement("option");
      o.value = wert;
      o.textContent = t(key);
      if (wert === libSort) o.selected = true;
      sel.appendChild(o);
    }
    knopf.textContent = libSortDesc ? "↓" : "↑";
    knopf.title = t(libSortDesc ? "lib_sort_desc" : "lib_sort_asc");
  }

  function merkeLibSort() {
    try {
      localStorage.setItem(LIB_SORT_KEY, JSON.stringify({ by: libSort, desc: libSortDesc }));
    } catch { /* voll */ }
  }

  $("lib-sort").addEventListener("change", (e) => {
    libSort = LIB_SORTS[e.target.value] ? e.target.value : "name";
    merkeLibSort();
    renderLibSort();
    renderLibrary();
  });
  $("lib-sort-dir").addEventListener("click", () => {
    libSortDesc = !libSortDesc;
    merkeLibSort();
    renderLibSort();
    renderLibrary();
  });
  renderLibSort();

  function renderLibrary() {
    const list = $("lib-list");
    list.innerHTML = "";
    if (!libLoaded) return;
    if (!libEntries.length) {
      list.appendChild(el("p", "hint", t("lib_empty")));
      libStatus("");
      return;
    }
    const rows = libVisible();
    libStatus(t("lib_count", rows.length, libEntries.length));
    if (!rows.length) {
      list.appendChild(el("p", "hint", t("lib_no_match")));
      return;
    }
    for (const { entry, check } of rows) {
      const m = entry.meta;
      const row = el("button", "lib-row" + (check.ok ? " ok" : ""));
      row.type = "button";
      row.title = check.ok ? t("lib_feasible_title") : t("lib_infeasible_title");
      const head = el("div", "lib-row-head");
      head.appendChild(el("span", "lib-name", entry.name));
      const badge = el("span", "lib-badge", check.ok ? "✓" : String(missingCount(check)));
      head.appendChild(badge);
      row.appendChild(head);
      row.appendChild(el("span", "lib-meta", t("lib_parts", m.connectors, m.tubes, m.panels)));
      row.appendChild(el("span", "lib-meta", t("lib_size", m.size[0], m.size[1], m.size[2])));
      row.addEventListener("click", () => openFromLibrary(entry, { preview: true }));
      row.addEventListener("dblclick", () => {
        const offen = tabs.find((x) => x.name === entry.name && x.preview);
        if (offen) pinTab(offen); else openFromLibrary(entry);
      });
      list.appendChild(row);
    }
  }

  /** Meine Modelle: gespeicherte Dateien, Klick öffnet sie in einem Tab. */
  /**
   * Kennzahlen einer gespeicherten Datei -- dieselben, die die Bibliothek je
   * Modell zeigt: Teilezahlen, Außenmaße und ob der eigene Bestand reicht.
   */
  function modellKennzahlen(doc) {
    if (!doc || !doc.data) return null;
    try {
      const m2 = new (model.constructor)();
      if (!m2.loadJSON(doc.data).ok) return null;
      const bom = computeBOM(m2);
      const cmp = compareInventory(bom, flacherBestand());
      const b2 = m2.bounds(geometry().connectorSize / 2);
      return {
        connectors: bom.totals.connectors, tubes: bom.totals.tubes, panels: bom.totals.panels,
        size: b2 ? b2.size.map((v) => Math.round(v)) : [0, 0, 0],
        ok: cmp.feasible,
        fehlt: cmp.rows.reduce((s2, r) => s2 + Math.max(0, r.need - r.owned), 0),
      };
    } catch (e) { console.warn("Kennzahlen:", e); return null; }
  }

  let ownRenderLauf = 0;
  async function renderOwnModels() {
    const box = $("own-list");
    if (!box) return;
    // Mehrere Aufrufe können sich überholen (Klick + update + Panel-Wechsel).
    // Nur der jüngste darf die Liste schreiben, sonst hängen die Einträge
    // mehrfach untereinander.
    const lauf = ++ownRenderLauf;
    let liste = [];
    try { liste = await docs.listDocs(); } catch (e) { console.warn("Dateien:", e); }
    if (lauf !== ownRenderLauf) return;
    box.innerHTML = "";
    if (!liste.length) { box.appendChild(el("div", "muted", t("saves_empty"))); return; }
    const iconKnopf = (svg, titel, fn) => {
      const b2 = el("button", "btn ghost icon-sq small");
      b2.innerHTML = svg;
      b2.title = titel;
      b2.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
      return b2;
    };
    const STIFT = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M11.2 2.4 13.6 4.8 5.6 12.8 2.4 13.6 3.2 10.4z"/></svg>`;
    const PFEIL = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8"/><path d="M5 7.2 8 10.4l3-3.2"/><path d="M2.6 12.6h10.8"/></svg>`;
    const MUELL = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.6h10"/><path d="M4.6 4.6 5.2 13h5.6l.6-8.4"/><path d="M6.4 4.6V3h3.2v1.6"/></svg>`;
    for (const d of liste) {
      const offen = tabs.some((x) => x.docId === d.id);
      const row = el("div", "lib-row own-row" + (offen ? " active" : ""));
      // Dieselben Angaben wie in der Bibliothek: Machbarkeit, Teilezahlen,
      // Außenmaße -- dazu das Datum der letzten Änderung.
      const kennzahlen = modellKennzahlen(d);
      if (kennzahlen && kennzahlen.ok) row.classList.add("ok");
      const links = el("div", "own-main");
      const kopf = el("div", "lib-head");
      kopf.appendChild(el("span", "lib-name", d.name));
      links.appendChild(kopf);
      if (kennzahlen) row.title = kennzahlen.ok ? t("lib_feasible_title") : t("lib_infeasible_title");
      if (kennzahlen) {
        links.appendChild(el("span", "lib-meta",
          t("lib_parts", kennzahlen.connectors, kennzahlen.tubes, kennzahlen.panels)));
        links.appendChild(el("span", "lib-meta",
          t("lib_size", kennzahlen.size[0], kennzahlen.size[1], kennzahlen.size[2])));
      }
      links.appendChild(el("span", "lib-meta",
        new Date(d.updatedAt || Date.now()).toLocaleString(locale())));
      row.appendChild(links);

      // Rechte Spalte: oben das Abzeichen (Haken oder fehlende Teile), unten
      // die Werkzeuge.
      const rechts = el("div", "own-side");
      if (kennzahlen) {
        rechts.appendChild(el("span", "lib-badge", kennzahlen.ok ? "✓" : String(kennzahlen.fehlt)));
      }
      const werkzeuge = el("div", "own-tools");
      werkzeuge.appendChild(iconKnopf(STIFT, t("btn_doc_rename"), async () => {
        const gewaehlt = await askName(d.name, { eigeneId: d.id });
        if (!gewaehlt) return;
        await docs.renameDoc(d.id, gewaehlt.name);
        for (const tab of tabs) if (tab.docId === d.id) tab.name = gewaehlt.name;
        sync.nudge();
        renderTabs(); renderOwnModels();
      }));
      werkzeuge.appendChild(iconKnopf(PFEIL, t("btn_export_qdf"), () => {
        // Offener Tab? Dann den Arbeitsstand nehmen, sonst die Datei.
        const tab = tabs.find((x) => x.docId === d.id);
        if (tab && tab.tabId === activeTabId) captureActiveTab();
        exportiereModell(d.name, tab ? tab.model : d.data);
      }));
      werkzeuge.appendChild(iconKnopf(MUELL, t("btn_doc_delete_title"), async () => {
        if (!(await askConfirm(t("confirm_delete_save", d.name), { title: t("dlg_delete_title"), ok: t("dlg_delete_ok"), danger: true }))) return;
        await docs.removeDoc(d.id);
        for (const tab of tabs) if (tab.docId === d.id) {
          tab.docId = null; tab.dirty = true; tab.savedJson = null;
        }
        sync.nudge();
        renderTabs(); renderOwnModels();
      }));
      rechts.appendChild(werkzeuge);
      row.appendChild(rechts);
      row.addEventListener("click", () => openDocById(d.id, { preview: true }));
      row.addEventListener("dblclick", () => openDocById(d.id));
      box.appendChild(row);
    }
  }

  async function openFromLibrary(entry, { preview = false } = {}) {
    // Mit Server liegen zunächst nur die Kennzahlen vor -- der QDF-Text kommt
    // beim Öffnen nach. Ist der Server gerade weg, geht das eben nicht.
    let qdf = entry.qdf;
    if (!qdf) {
      try {
        qdf = await sync.libQdf(entry);
      } catch (e) {
        showMessage(t("sync_lib_offline", entry.name), { title: t("dlg_error_title") });
        return;
      }
    }
    const data = parseDesign(qdf);
    if (!data) { flash(t("lib_load_failed"), "error"); return; }
    // Die Sammlung bleibt, wie sie ist: geöffnet wird eine KOPIE in einem
    // eigenen Tab, die noch zu keiner Datei gehört.
    openTab({ name: entry.name, data, preview });
    scene.resetCamera(model);
    flash(t("lib_loaded", entry.name));
  }


  $("lib-add-folder").addEventListener("click", () => $("lib-file-folder").click());
  $("lib-add-files").addEventListener("click", () => $("lib-file-list").click());
  for (const id of ["lib-file-folder", "lib-file-list"]) {
    $(id).addEventListener("change", async (e) => {
      // FileList ist LEBENDIG: das Zuruecksetzen von value leert sie sofort
      // wieder. Deshalb erst kopieren, dann das Feld freigeben (sonst laesst
      // sich derselbe Ordner nicht ein zweites Mal waehlen).
      const files = [...e.target.files];
      e.target.value = "";
      await addToLibrary(files);
    });
  }
  $("lib-clear").addEventListener("click", async () => {
    if (!libEntries.length) return;
    if (!(await askConfirm(t("lib_confirm_clear"), { title: t("dlg_delete_title"), ok: t("dlg_delete_ok"), danger: true }))) return;
    await storage.libClear();
    sync.nudge();
    await loadLibrary();
  });
  $("lib-search").addEventListener("input", renderLibrary);
  $("lib-only-feasible").addEventListener("change", (e) => {
    if (e.target.checked && inventoryEmpty()) {
      e.target.checked = false;
      flash(t("lib_no_inventory"), "warn");
    }
    renderLibrary();
  });

  // Ohne eingetragenen Bestand ist der Machbarkeits-Filter sinnlos.
  function inventoryEmpty() {
    for (const bucket of Object.values(inventory)) {
      if (bucket && Object.values(bucket).some((v) => v > 0)) return false;
    }
    return true;
  }

  // --- Seitenleiste: EIN Panel auf Abruf (Stückliste / Bestand) ----------
  // Die Leiste ist standardmäßig zu (body.sidebar-hidden im HTML). Die
  // Menüband-Buttons "Stückliste" und "Bestand" öffnen je genau ihr Panel;
  // erneuter Klick schließt wieder. Der Aufbau-Modus zeigt das Aufbau-Panel.
  const SIDEBAR_W_KEY = "quadro.sidebarWidth.v1";
  const SIDEBAR_PANEL_KEY = "quadro.sidebarPanel.v1"; // '', 'bom', 'inventory', 'library'
  const root = document.documentElement;
  const savedW = parseInt(localStorage.getItem(SIDEBAR_W_KEY), 10);
  if (savedW >= 240 && savedW <= 640) root.style.setProperty("--sidebar-w", savedW + "px");

  let currentPanel = null;      // 'bom' | 'library' | 'assembly' | null
  let vorAufbauPanel = "bom";   // wohin die Leiste nach dem Aufbau zurückkehrt
  // Womit die Leiste wieder aufgeht. Der Aufbau zählt nicht: seinen Tab gibt es
  // außerhalb des Aufbau-Modus nicht.
  let letzterPanel = localStorage.getItem(SIDEBAR_PANEL_KEY) || "bom";

  /**
   * Liegt die Schnittebenen-Leiste als Leiste UEBER dem Bild (schmale Schirme),
   * rueckt der Ansichtswuerfel darunter -- sonst steckt er dahinter.
   */
  function syncCubeInset() {
    const bar = $("slice-bar");
    const alsLeiste = !bar.hidden && window.matchMedia("(max-width: 760px)").matches;
    const inset = alsLeiste ? bar.getBoundingClientRect().height + 8 : 0;
    scene.setViewCubeInset(inset);
    // Derselbe Versatz gilt fuer den Szene-Knopf oben links (siehe .scene-icon).
    root.style.setProperty("--slice-inset", inset + "px");
  }

  function applyPanelVisibility() {
    $("panel-bom").hidden = currentPanel !== "bom";
    $("panel-own").hidden = currentPanel !== "own";
    $("panel-library").hidden = currentPanel !== "library";
    // Steckt das Aufbau-Panel in der Karte ueber der Szene, gehoert es nicht
    // der Seitenleiste -- dann darf ihr Sichtbarkeits-Schalter es nicht zumachen.
    $("panel-assembly").hidden = currentPanel !== "assembly"
      && !document.body.classList.contains("asm-sheet-on");
    document.body.classList.toggle("sidebar-hidden", currentPanel === null);
    $("toggle-sidebar").classList.toggle("active", currentPanel !== null);
    // Der Hintergrund gehoert nur zur ueberlagernden Leiste. Er bleibt im
    // Dokument stehen und wird ein-/ausgeblendet, damit die Blende laeuft.
    $("sidebar-backdrop").classList.toggle("open",
      currentPanel !== null && document.body.classList.contains("sidebar-overlay"));
    renderSideTabs();
    requestAnimationFrame(() => scene.onResize());
  }
  // name: 'bom' | 'inventory' | 'library' | 'assembly' | null.
  // Nur bom/inventory/library/zu wird gemerkt.
  function showSidebarPanel(name) {
    // Beim Zumachen merken, was zu sehen war -- egal auf welchem Weg zugemacht
    // wurde (Knopf, Hintergrund, Escape). Beim nächsten Öffnen kommt genau das
    // wieder, statt immer der Stückliste.
    if (name === null && currentPanel && currentPanel !== "assembly") letzterPanel = currentPanel;
    currentPanel = name;
    if (name === "own") renderOwnModels();
    if (name === "library" && !libLoaded) loadLibrary();
    if (name === "bom" || name === "own" || name === "library" || name === null)
      localStorage.setItem(SIDEBAR_PANEL_KEY, name || "");
    applyPanelVisibility();
  }
  function toggleSidebarPanel(name) {
    showSidebarPanel(currentPanel === name ? null : name);
  }

  // Tab-Leiste in der Seitenleiste: Stückliste & Bestand, Modelle, Aufbau.
  // "Aufbau" gibt es nur im Aufbau-Modus und wird dort automatisch gewählt.
  function renderSideTabs() {
    for (const b of $("side-tabs").querySelectorAll(".side-tab")) {
      const name = b.dataset.panel;
      b.classList.toggle("active", currentPanel === name);
      if (name === "assembly") {
        b.hidden = builder.mode !== "assembly"
          || document.body.classList.contains("asm-sheet-on");
      }
    }
  }
  for (const b of $("side-tabs").querySelectorAll(".side-tab")) {
    b.addEventListener("click", () => showSidebarPanel(b.dataset.panel));
  }

  // EIN Knopf oben rechts: Leiste auf oder zu. Welcher Inhalt zu sehen ist,
  // wählt die Tab-Leiste in der Seitenleiste selbst.
  $("toggle-sidebar").addEventListener("click", () => {
    showSidebarPanel(currentPanel ? null : (letzterPanel || "bom"));
  });

  // Szene (Gras, Baeume, Himmel) ein-/ausblenden via Canvas-Icon. Der Zustand
  // wird gemerkt; Standard beim allerersten Start ist aus.
  const SCENE_KEY = "quadro.scene.v1";
  let grassOn = false;
  const sceneIcon = $("scene-toggle");
  const applyScene = (on, save = true) => {
    grassOn = on;
    scene.setScene(on);
    sceneIcon.classList.toggle("off", !on);
    if (save) localStorage.setItem(SCENE_KEY, on ? "1" : "0");
  };
  sceneIcon.addEventListener("click", () => applyScene(!grassOn));
  applyScene(localStorage.getItem(SCENE_KEY) === "1", false);

  // Startzustand: zuletzt gewähltes Panel. Beim allerersten Aufruf steht noch
  // nichts im Speicher -- dann ist die Leiste offen und zeigt die Stückliste.
  const gemerktesPanel = localStorage.getItem(SIDEBAR_PANEL_KEY);
  showSidebarPanel(gemerktesPanel === null ? "bom" : (gemerktesPanel || null));

  (function initResizer() {
    const res = $("sidebar-resizer");
    if (!res) return;
    let dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      const w = Math.min(640, Math.max(240, window.innerWidth - e.clientX));
      root.style.setProperty("--sidebar-w", w + "px");
      scene.onResize();
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("resizing");
      const w = parseInt(getComputedStyle(root).getPropertyValue("--sidebar-w"), 10);
      if (w) localStorage.setItem(SIDEBAR_W_KEY, String(w));
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    res.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      dragging = true;
      document.body.classList.add("resizing");
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  })();

  // --- Aufbaumodus (Stepper) ---------------------------------------------
  // Farben in der Aufbauliste zusammenfassen (Zustand ueberlebt den Reload).
  const ASM_COLOR_KEY = "quadro.asmColors.v1";
  let asmIgnoreColors = localStorage.getItem(ASM_COLOR_KEY) === "1";
  let asmShownStep = -1;
  const asmNoColor = $("asm-nocolor");
  if (asmNoColor) {
    asmNoColor.checked = asmIgnoreColors;
    asmNoColor.addEventListener("change", () => {
      asmIgnoreColors = asmNoColor.checked;
      localStorage.setItem(ASM_COLOR_KEY, asmIgnoreColors ? "1" : "0");
      // Zusammengefasste und getrennte Zeilen haben verschiedene Schluessel.
      if (asmHighlightKey) { asmHighlightKey = null; builder.setHighlight(null); }
      renderAssembly();
    });
  }

  $("asm-prev").addEventListener("click", () => builder.setAssemblyStep(builder.assemblyStep - 1));
  $("asm-next").addEventListener("click", () => builder.setAssemblyStep(builder.assemblyStep + 1));

  // Aufbaurichtung: je nach Modell und Platz im Raum ist eine andere Reihenfolge
  // praktischer als die Standard-Reihenfolge von unten nach oben.
  const ORDER_KEYS = { "y+": "asm_order_yp", "x+": "asm_order_xp", "x-": "asm_order_xm",
                       "z+": "asm_order_zp", "z-": "asm_order_zm" };
  const ORDER_KEY = "quadro.asmOrder.v1";
  const orderSel = $("asm-order");
  // Gewaehlte Reihenfolge ueberlebt den Reload; sie gehoert zum Arbeitsstand,
  // nicht zum Modell.
  const storedOrder = localStorage.getItem(ORDER_KEY);
  if (storedOrder && BUILD_ORDERS.includes(storedOrder)) builder.setAssemblyOrder(storedOrder);
  function renderOrderOptions() {
    if (!orderSel) return;
    orderSel.innerHTML = "";
    for (const [value, key] of Object.entries(ORDER_KEYS)) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = t(key);
      if (value === builder.assemblyOrder) o.selected = true;
      orderSel.appendChild(o);
    }
  }
  renderOrderOptions();
  if (orderSel) orderSel.addEventListener("change", () => {
    builder.setAssemblyOrder(orderSel.value);
    localStorage.setItem(ORDER_KEY, orderSel.value);
    renderAssembly();
  });

  function asmRow(container, name, colorId, count, icon, sel) {
    const row = el("div", "asm-row");
    const label = el("span", "asm-name");
    // Dasselbe Sinnbild wie in der Stückliste und an den Knöpfen.
    const sinnbild = el("span", "bom-icon");
    if (icon) sinnbild.innerHTML = icon;
    label.appendChild(sinnbild);
    if (colorId) {
      const dot = el("span", "dot"); dot.style.background = colorHex(colorId);
      label.appendChild(dot);
    }
    label.appendChild(document.createTextNode(name));
    row.appendChild(label);
    row.appendChild(el("span", "asm-count", `${count}×`));
    if (sel) {
      const key = asmRowKey(sel);
      row.dataset.asmKey = key;
      if (key === asmHighlightKey) row.classList.add("marked");
      // Klick hebt genau diese Teile des Schrittes im Modell hervor; ein
      // zweiter Klick nimmt die Hervorhebung wieder zurueck.
      row.addEventListener("click", () => {
        setAssemblyHighlight(key === asmHighlightKey ? null : sel);
      });
    }
    container.appendChild(row);
  }

  // --- Hervorhebung aus der Aufbau-Liste ---------------------------------
  // Wie in der Bestandsliste: eine Zeile anklicken faerbt die zugehoerigen
  // Teile lila, alle uebrigen treten zurueck. Gesucht wird nur INNERHALB des
  // aktuellen Schritts -- gleiche Teile spaeterer Lagen bleiben unberuehrt.
  let asmHighlightKey = null;

  function asmRowKey(sel) {
    return [sel.kind, sel.type || sel.tubeId || sel.panelId || sel.id || "", sel.color || ""].join(":");
  }

  function partsForAssemblyRow(step, sel) {
    const ids = new Set();
    if (!step) return ids;
    if (sel.kind === "connector" || sel.kind === "openEnds") {
      for (const id of step.nodeIds || []) {
        const n = model.nodes.get(id);
        if (!n) continue;
        const types = connectorsForNode(model, n);
        if (sel.kind === "connector" ? types.includes(sel.type)
          : (types.length === 0 && model.degree(id) >= 1)) ids.add(id);
      }
    } else if (sel.kind === "tube") {
      for (const id of step.tubeIds || []) {
        const t = model.tubes.get(id);
        if (t && t.tubeId === sel.tubeId && (sel.color == null || t.color === sel.color)) ids.add(id);
      }
    } else if (sel.kind === "panel") {
      for (const id of step.panelIds || []) {
        const p = model.panels.get(id);
        if (p && p.panelId === sel.panelId && (sel.color == null || p.color === sel.color)) ids.add(id);
      }
    } else if (sel.kind === "reinforcement") {
      // Gezeigt werden die Rohre, in denen die Profile stecken.
      for (const id of step.tubeIds || []) {
        const tb = model.tubes.get(id);
        if (tb && tb.reinforced) ids.add(id);
      }
    }
    return ids;
  }

  function setAssemblyHighlight(sel) {
    const step = builder.buildPlan.steps[builder.assemblyStep];
    asmHighlightKey = sel ? asmRowKey(sel) : null;
    builder.setHighlight(sel ? partsForAssemblyRow(step, sel) : null);
    for (const r of $("asm-body").querySelectorAll(".asm-row"))
      r.classList.toggle("marked", !!asmHighlightKey && r.dataset.asmKey === asmHighlightKey);
  }

  // Rohr-/Plattenzeilen ohne Farbe zusammenfassen. Die Zaehlung im Aufbauplan
  // trennt nach Farbe -- beim Bauen ist oft nur wichtig, WELCHES Teil und wie
  // viele davon.
  function mergeByPart(rows, idKey) {
    const map = new Map();
    for (const r of rows) {
      const k = r[idKey];
      if (!map.has(k)) map.set(k, { ...r, color: null, colorName: null, count: 0 });
      map.get(k).count += r.count;
    }
    return [...map.values()];
  }

  function renderAssembly() {
    const plan = builder.buildPlan;
    const total = plan.steps.length;
    const i = builder.assemblyStep;
    // Wurde die Hervorhebung von aussen aufgehoben (Klick auf ein Teil im
    // Modell), darf keine Zeile mehr markiert bleiben.
    if (!builder.highlight) asmHighlightKey = null;
    // Die Hervorhebung gilt immer nur fuer den gezeigten Schritt.
    if (i !== asmShownStep) {
      asmShownStep = i;
      if (asmHighlightKey) { asmHighlightKey = null; builder.setHighlight(null); }
    }
    $("asm-counter").textContent = total ? t("asm_counter", i, total) : "–";
    $("asm-prev").disabled = i <= 0;
    $("asm-next").disabled = i >= total - 1;
    $("asm-progress-bar").style.width = total ? `${((i + 1) / total) * 100}%` : "0%";

    const body = $("asm-body");
    body.innerHTML = "";
    const step = plan.steps[i];
    if (!step) {
      body.appendChild(el("div", "muted", t("asm_empty_body")));
      return;
    }
    const plain = asmIgnoreColors;
    if (step.connectors.length || step.openEnds) {
      body.appendChild(el("h4", "asm-cat", t("asm_cat_connectors")));
      for (const c of step.connectors)
        asmRow(body, c.name, null, c.count, bomIcon("connectors", c.type), { kind: "connector", type: c.type });
      if (step.openEnds) asmRow(body, t("asm_open_ends"), null, step.openEnds, null, { kind: "openEnds" });
    }
    if (step.tubes.length) {
      body.appendChild(el("h4", "asm-cat", t("asm_cat_tubes")));
      for (const tube of (plain ? mergeByPart(step.tubes, "tubeId") : step.tubes))
        asmRow(body, plain ? tube.name : `${tube.name} · ${tube.colorName}`,
          tube.color, tube.count, bomIcon("tubes", tube.tubeId),
          { kind: "tube", tubeId: tube.tubeId, color: tube.color });
    }
    if (step.panels.length) {
      body.appendChild(el("h4", "asm-cat", t("asm_cat_panels")));
      for (const p of (plain ? mergeByPart(step.panels, "panelId") : step.panels))
        asmRow(body, plain ? p.name : `${p.name} · ${p.colorName}`,
          p.color, p.count, bomIcon("panels", p.panelId),
          { kind: "panel", panelId: p.panelId, color: p.color });
    }
    // Die Profile stecken IN den Rohren dieses Schritts -- sie gehoeren also
    // eingeschoben, bevor die Rohre verbaut werden.
    for (const r of (step.reinforcements || [])) {
      body.appendChild(el("h4", "asm-cat", t("asm_cat_reinforcements")));
      asmRow(body, r.name, null, r.count, bomIcon("reinforcements", r.id),
        { kind: "reinforcement", id: r.id });
    }
  }

  // --- Tastatur ----------------------------------------------------------
  window.addEventListener("keydown", (e) => {
    // Steht ein Dialog offen, gehört die Tastatur ihm allein.
    if (dialogOpen()) return;
    const tgt = e.target;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "SELECT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) builder.redo();
      else builder.undo();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      builder.redo();
      return;
    }
    // Strg+C / Strg+V: Auswahl kopieren und am Zeiger wieder einsetzen. Die
    // Zwischenablage lebt im Speicher der Seite -- damit auch in einem anderen
    // Entwurf-Tab, aber nicht ueber einen Reload hinaus.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && !e.shiftKey) {
      if (builder.mode !== "select") return;
      e.preventDefault();
      const frag = builder.copySelection();
      if (!frag) { flash(t("flash_copy_empty"), "warn"); return; }
      clipboard = frag;
      flash(t("flash_copied", frag.tubes.length + frag.panels.length
        + frag.textiles.length + frag.slides.length + frag.fittings.length + frag.clamps.length));
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v" && !e.shiftKey) {
      e.preventDefault();
      if (!clipboard) { flash(t("flash_paste_empty"), "warn"); return; }
      builder.startPaste(clipboard);
      flash(t("flash_paste_hint"), "info");
      return;
    }
    // Drehen: Strg/Cmd + Pfeil links/rechts dreht die Auswahl (oder die Kopie am
    // Zeiger) um 90 Grad um die Hochachse. Ohne Strg schieben die Pfeiltasten.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey
        && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      if (builder.rotateSelectionBy(e.key === "ArrowRight" ? 1 : -1)) flash(t("flash_rotated"));
      return;
    }
    // Strg+A: alles auswaehlen -- nur im Cursor-Modus, sonst gibt es keine
    // Auswahl, die es treffen koennte (und der Browser markiert die Seite).
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      if (builder.mode !== "select") return;
      e.preventDefault();
      const n = builder.selectAll();
      flash(t("flash_selected_n", n));
      return;
    }
    // Neues Modell: Alt+N. Strg/Cmd+N bleibt mit drin, kommt in Chrome aber
    // nicht an -- der Browser oeffnet damit ein eigenes Fenster, bevor die
    // Seite die Taste sieht. Deshalb steht in der Hilfe nur Alt+N.
    if ((e.metaKey || e.ctrlKey || e.altKey) && e.key.toLowerCase() === "n" && !e.shiftKey) {
      e.preventDefault();
      $("btn-doc-new").click();
      return;
    }
    // Tab schliessen. Strg/Cmd+W geht NICHT: das fangen die Browser selbst ab
    // (Tab zu), noch bevor die Seite das Ereignis sieht. Alt+W kommt an.
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "w") {
      e.preventDefault();
      if (activeTabId) closeTab(activeTabId);
      return;
    }
    // Datei-Tasten: was der Browser damit vorhat (Seite speichern, Datei
    // oeffnen), ist hier fehl am Platz -- der Editor ist die Anwendung.
    if (e.metaKey || e.ctrlKey) {
      switch (e.key.toLowerCase()) {
        case "s": e.preventDefault(); (e.shiftKey ? $("btn-doc-saveas") : $("btn-doc-save")).click(); return;
        case "o": e.preventDefault(); $("btn-doc-open").click(); return;
        case "e": e.preventDefault(); exportActiveTab(); return;
      }
      // Strg/Cmd+1…9 springt zum n-ten Entwurf, die 9 ans Ende -- wie die
      // Tab-Tasten im Browser. Ob der Browser die Taste durchlaesst, haengt an
      // ihm; Firefox und Safari tun es nicht, Chrome schon.
      if (e.key >= "1" && e.key <= "9" && !e.shiftKey) {
        const n = parseInt(e.key, 10);
        const ziel = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
        if (ziel) {
          e.preventDefault();
          if (ziel.tabId !== activeTabId) activateTab(ziel.tabId);
        }
        return;
      }
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;

    if (builder.mode === "assembly") {
      if (k === "ArrowRight" || k === "ArrowUp" || k === "PageUp") {
        e.preventDefault(); builder.setAssemblyStep(builder.assemblyStep + 1); return;
      }
      if (k === "ArrowLeft" || k === "ArrowDown" || k === "PageDown") {
        e.preventDefault(); builder.setAssemblyStep(builder.assemblyStep - 1); return;
      }
    }

    // Die Pfeiltasten folgen dem Blickwinkel: schaut man frontal auf das Modell,
    // baut Pfeil-hoch nach OBEN, aus der Aufsicht nach hinten. So zeigt die
    // Taste immer dorthin, wo das Rohr auf dem Bildschirm auch erscheint. Fuer
    // die dritte Achse dreht man die Ansicht -- eigene Tasten braucht es nicht.
    const axes = scene.getHorizontalAxes();
    const frontal = scene.isFrontalView();
    let dir = null;
    if (k === "ArrowUp") dir = frontal ? [0, 1, 0] : axes.forward;
    else if (k === "ArrowDown") dir = frontal ? [0, -1, 0] : neg(axes.forward);
    else if (k === "ArrowRight") dir = axes.right;
    else if (k === "ArrowLeft") dir = neg(axes.right);
    if (dir) {
      e.preventDefault();
      // Cursor-Modus mit Auswahl: die Pfeiltasten schieben sie im Raster,
      // statt in den Bau-Modus zu springen.
      if (builder.mode === "select" && builder.selection.size) {
        builder.moveSelectionBy(dir);
        return;
      }
      if (builder.mode !== "add") setMode("add");
      builder.buildStep(dir);
      return;
    }

    // Zifferntasten waehlen ein Rohr -- und schalten dafuer in den Bau-Modus,
    // sonst haette die Wahl im Cursor-Modus keine sichtbare Wirkung.
    if (k >= "1" && k <= "9") {
      const idx = parseInt(k, 10) - 1;
      if (idx < tubes.length) {
        builder.setTube(tubes[idx].id);
        if (builder.mode !== "add") setMode("add");
        syncPartHighlights();
      }
      return;
    }

    switch (k.toLowerCase()) {
      case "b": setMode("add"); break;
      case "p": setMode("panel"); break;
      case "r": setMode("slide"); break;
      case "f": setMode("fitting"); break;
      case "s": setMode("select"); break;
      case "v": setMode("reinforce"); break;
      case "a": setMode("assembly"); break;
      case "k": setMode("clamp"); break;
      // Drehen wie mit Strg+Pfeil -- Q gegen, E im Uhrzeigersinn.
      case "q": if (builder.rotateSelectionBy(-1)) flash(t("flash_rotated")); break;
      case "e": if (builder.rotateSelectionBy(1)) flash(t("flash_rotated")); break;
      case "c": scene.resetCamera(model); break;
      // Die Liste der Tasten selbst: F1 wie ueberall, "?" fuer die Tastatur
      // ohne F-Reihe.
      case "f1":
      case "?":
        e.preventDefault();
        $("help-overlay").hidden = !$("help-overlay").hidden;
        break;
      // Escape fuehrt zurueck in den Cursor-Modus -- ausser im Aufbau-Modus:
      // dort ist die Auswahl nur zum Nachschlagen da, Escape raeumt sie weg und
      // laesst den Modus stehen (ihn zu verlassen waere ein Verlust an
      // Fortschritt fuer eine Taste, die man beilaeufig drueckt).
      case "escape":
        closePopup();
        // Haengt eine Kopie am Zeiger, nimmt Escape zuerst sie weg.
        if (builder.cancelPaste()) { flash(t("flash_paste_cancelled"), "info"); update(); break; }
        // Offene Overlays zuerst: Escape schliesst sie, statt den Modus zu wechseln.
        if (!$("help-overlay").hidden) { $("help-overlay").hidden = true; break; }
        // Ueberlagernde Seitenleiste verhaelt sich wie ein Menue: Escape zu.
        if (currentPanel && document.body.classList.contains("sidebar-overlay")) {
          showSidebarPanel(null);
          break;
        }
        // Erst aufraeumen, dann den Modus wechseln: ein Escape, das eine
        // Markierung wegnimmt, soll einen nicht gleichzeitig aus dem Modus
        // werfen. Im Aufbau-Modus wird der Modus nie verlassen.
        if (builder.clearMarks()) { update(); break; }
        if (builder.mode !== "assembly") setMode("select");
        break;
      case "delete":
      case "backspace":
        if (builder.mode === "select") {
          if (!builder.selection.size) break;
          e.preventDefault();
          flash(t("flash_deleted_n", builder.deleteSelection()));
          syncDeleteButton();
        } else if (builder.selectedNodeId) {
          e.preventDefault();
          const id = builder.selectedNodeId;
          builder.selectedNodeId = null;
          builder.recordHistory(() => model.removeNode(id));
          builder.refresh();
        }
        break;
    }
  });

  // --- Stueckliste + Bestand ---------------------------------------------
  function colorHex(id) {
    const c = tubeColors().find((x) => x.id === id);
    return c ? c.hex : "#888";
  }

  /**
   * Eine Zeile der Stückliste.
   * `invKey` ("gruppe:id") verbindet sie mit dem Bestand: dann steht statt der
   * blossen Anzahl "vorhanden/benötigt", und reicht der Bestand nicht, ist die
   * Zeile rot hinterlegt. Im Bearbeiten-Modus wird daraus ein Eingabefeld.
   * `hl` beschreibt, welche Teile ein Klick im Modell hervorhebt.
   */
  function bomRow(container, name, colorId, count, subtotal, invKey = null, hl = null, icon = null) {
    const inv = invKey ? invIndex.get(invKey) : null;
    const bedarf = inv ? inv.need : count;
    const marke = hl ? hlKey(hl) : null;
    const row = el("div", "bom-row" + (inv && !inv.ok && !bomEditMode ? " bad" : "")
      + (marke && marke === bomHighlightKey ? " marked" : ""));
    const label = el("span", "bom-name");
    // Sinnbild wie am zugehörigen Knopf -- ohne eines bleibt die Spalte leer,
    // damit die Namen trotzdem auf einer Linie stehen.
    const sinnbild = el("span", "bom-icon");
    if (icon) sinnbild.innerHTML = icon;
    label.appendChild(sinnbild);
    if (colorId) {
      const dot = el("span", "dot"); dot.style.background = colorHex(colorId);
      label.appendChild(dot);
    }
    label.appendChild(document.createTextNode(name));
    row.appendChild(label);

    if (bomEditMode && invKey) {
      // Bearbeiten: benötigte Anzahl links, eigener Bestand als Eingabe.
      const [bucket, id] = invKey.split(/:(.+)/);
      row.appendChild(el("span", "bom-count", bedarf ? `${bedarf}×` : ""));
      const inp = document.createElement("input");
      inp.type = "number"; inp.min = "0"; inp.className = "inv-input";
      inp.value = (inventory[bucket] && inventory[bucket][id]) || 0;
      inp.addEventListener("click", (e) => e.stopPropagation());
      inp.addEventListener("change", () => {
        const v = Math.max(0, parseInt(inp.value || "0", 10) || 0);
        if (v) inventory[bucket][id] = v; else delete inventory[bucket][id];
      });
      row.appendChild(inp);
      // Nachschlagen beim Hersteller: was ist das Teil, was kostet es, gibt es
      // das noch? Der Link steht im Katalog (`url` in parts.json); wo es das
      // Teil nicht einzeln gibt, führt er auf die passende Übersichtsseite.
      // Nach Farben getrennt heisst die Bestands-Kennung "id|farbe" -- das Teil
      // ist dasselbe, im Laden gibt es dafuer eine einzige Seite.
      const def = getPartById(id.split("|")[0]);
      if (def && def.url) {
        const link = document.createElement("a");
        link.className = "part-info";
        link.href = def.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.title = t("inv_shop_link", partName(def));
        // Gezeichnetes "i" im Kreis statt des Zeichens U+1F6C8: dafür fehlt
        // vielen Systemschriften (vor allem auf Android) die Glyphe, und der
        // Browser setzte irgendein Ersatzbild ein.
        link.innerHTML = svg16(
          '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/>'
          + '<circle cx="8" cy="4.9" r="0.95" fill="currentColor"/>'
          + '<path d="M8 7.3v4.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>');
        link.addEventListener("click", (e) => e.stopPropagation());
        row.appendChild(link);
      }
    } else {
      // Anzeigen: entweder "vorhanden/benötigt" oder nur die Anzahl.
      row.appendChild(el("span", "bom-count", inv ? `${inv.owned}/${inv.need}` : `${count}×`));
      if (inv) row.title = t("inv_have", inv.owned, inv.need);
    }
    if (bomShowPrice) row.appendChild(el("span", "bom-sub", subtotal == null ? "" : eur(subtotal)));
    if (marke && !bomEditMode) {
      // Anklickbar: hebt die Teile dieser Zeile im Modell hervor.
      row.classList.add("clickable");
      row.addEventListener("click", () => setBomHighlight(marke === bomHighlightKey ? null : hl));
    }
    container.appendChild(row);
  }

  // Hervorhebung aus der Stückliste: welche Zeile ist markiert?
  let bomHighlightKey = null;
  const hlKey = (hl) => `${hl.kind}:${hl.id}:${hl.color || ""}`;

  // Teile, die die App zwar führt, aber nicht zeichnet (in `scene.js` fällt
  // `_fittingMeshes` für sie in den Default). Hervorgehoben wird deshalb die
  // Kupplung bzw. das Rohr, an der sie sitzen -- sonst bliebe der Klick auf die
  // Zeile ohne jede Wirkung.
  // Anbauteile, die die Szene NICHT zeichnet -- ihre Hervorhebung braucht einen
  // sichtbaren Ersatz in der Naehe. Seit die abgegriffenen Modelle da sind, ist
  // das nur noch die Flexikupplung; Bolzen, Lagerkupplung und Rohrkappe werden
  // gezeichnet und heben sich selbst hervor.
  const UNDRAWN_FITTINGS = new Set(["flexi-connector3"]);

  /** Sichtbarer Stellvertreter für ein Teil, das nicht gezeichnet wird. */
  function visibleStandIn(f) {
    let best = null, bestDist = 8;
    for (const n of model.nodes.values()) {
      if (n.unused) continue;
      const d = Math.hypot(n.x - f.x, n.y - f.y, n.z - f.z);
      if (d < bestDist) { bestDist = d; best = n.id; }
    }
    if (best) return best;
    // Die Lagerkupplung klemmt mitten auf einem Rohr, dort gibt es keinen Knoten.
    bestDist = 8;
    for (const tb of model.tubes.values()) {
      if (tb.arm || tb.link) continue;
      const a = model.nodes.get(tb.a), b = model.nodes.get(tb.b);
      if (!a || !b) continue;
      const ab = [b.x - a.x, b.y - a.y, b.z - a.z];
      const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1;
      let s2 = ((f.x - a.x) * ab[0] + (f.y - a.y) * ab[1] + (f.z - a.z) * ab[2]) / len2;
      s2 = Math.max(0, Math.min(1, s2));
      const d = Math.hypot(a.x + ab[0] * s2 - f.x, a.y + ab[1] * s2 - f.y, a.z + ab[2] * s2 - f.z);
      if (d < bestDist) { bestDist = d; best = tb.id; }
    }
    return best;
  }

  /**
   * Anbauteile, die zu einem Katalogteil gehören. Das Bällebad steht im Katalog
   * als Poolfolie -- welche, sagt seine Grundfläche, nicht seine QDF-Art.
   */
  function fittingsForPart(partId) {
    const ids = new Set();
    for (const f of model.fittings.values()) {
      const def = POOL_KINDS.has(f.kind)
        ? poolLinerFor(Math.abs(f.w || 0), Math.abs(f.d || 0))
        : partForFitting(f.kind, f.mask);
      if (!def || def.id !== partId) continue;
      const id = UNDRAWN_FITTINGS.has(f.kind) ? visibleStandIn(f) : f.id;
      if (id) ids.add(id);
    }
    return ids;
  }

  /** Teile im Modell, die zu einer Stücklisten-Zeile gehören. */
  function partsForBomRow(hl) {
    const ids = new Set();
    const farbePasst = (el2) => !hl.color || el2.color === hl.color;
    if (hl.kind === "tubes") {
      for (const tb of model.tubes.values())
        if (!tb.arm && !tb.link && tb.tubeId === hl.id && farbePasst(tb)) ids.add(tb.id);
    } else if (hl.kind === "panels") {
      for (const p of model.panels.values())
        if (p.panelId === hl.id && farbePasst(p)) ids.add(p.id);
    } else if (hl.kind === "connectors") {
      for (const n of model.nodes.values()) {
        if (n.unused) continue;
        for (const typ of connectorsForNode(model, n)) if (typ === hl.id) { ids.add(n.id); break; }
      }
    } else if (hl.kind === "fittings") {
      for (const id of fittingsForPart(hl.id)) ids.add(id);
    } else if (hl.kind === "reinforcements") {
      for (const tb of model.tubes.values()) if (tb.reinforced) ids.add(tb.id);
    } else if (hl.kind === "textiles") {
      for (const tx of model.textiles.values()) if (farbePasst(tx)) ids.add(tx.id);
    } else if (hl.kind === "slides") {
      for (const sl of model.slides.values()) if (sl.kind === hl.id) ids.add(sl.id);
    }
    return ids;
  }

  function setBomHighlight(hl) {
    bomHighlightKey = hl ? hlKey(hl) : null;
    builder.setHighlight(hl ? partsForBomRow(hl) : null);
    update();
  }

  // Wohin ein Zubehörteil in Stückliste und Bestand gehört. Textilien und
  // Räder haben eigene Abschnitte, der Rest bleibt "Anbauteile".
  const TEXTIL_ARTEN = new Set(["textil2", "lattice2", "textil-round2", "bag2", "roof-large2"]);
  const RAD_ARTEN = new Set(["multi-wheel2", "floating-wheel2", "hub-cap2", "casters2",
    "adapter2", "bearing2", "steering-lock2"]);
  function zubehoerGruppe(art) {
    if (TEXTIL_ARTEN.has(art)) return "textiles";
    if (RAD_ARTEN.has(art)) return "wheels";
    return "fittings";
  }

  /**
   * Abschnitt der Stückliste ein- oder ausblenden -- samt seiner Überschrift.
   * Was das Modell nicht braucht, steht auch nicht in der Liste; ein „–" unter
   * einer Überschrift ist nur Platz ohne Aussage. Die Überschrift steht im
   * HTML direkt vor ihrer Liste.
   */
  function bomAbschnitt(boxId, leer) {
    const box = $(boxId);
    if (!box) return null;
    const kopf = box.previousElementSibling;
    box.hidden = leer;
    if (kopf && kopf.tagName === "H3") kopf.hidden = leer;
    return box;
  }

  // Bestand je Katalogteil, aufgeschlüsselt für die Stücklisten-Zeilen.
  let invIndex = new Map();

  /**
   * Bestand kann farbgenau geführt werden: neben "T35" steht dann "T35|red".
   * Für die Machbarkeit zählt die Summe über alle Farben eines Teils.
   */
  function bestandSumme(bucket, id) {
    const topf = inventory[bucket] || {};
    let summe = topf[id] || 0;
    for (const [k, v] of Object.entries(topf)) {
      const [teil, farbe] = k.split("|");
      if (farbe && teil === id) summe += v || 0;
    }
    return summe;
  }

  /** Bestandsobjekt, in dem die Farbvarianten je Teil zusammengezählt sind. */
  function flacherBestand() {
    const out = {};
    for (const [bucket, topf] of Object.entries(inventory)) {
      out[bucket] = {};
      for (const [k, v] of Object.entries(topf || {})) {
        const teil = k.split("|")[0];
        out[bucket][teil] = (out[bucket][teil] || 0) + (v || 0);
      }
    }
    return out;
  }
  const round2Preis = (v) => Math.round(v * 100) / 100;

  // Nach Farben getrennte Zeilen? Merkt sich die Wahl über Sitzungen hinweg.
  let bomEditMode = false;      // Bestand bearbeiten statt nur anzeigen
  const BOM_PRICE_KEY = "quadro.bomShowPrice.v1";
  let bomShowPrice = localStorage.getItem(BOM_PRICE_KEY) === "1";
  const bomPriceBox = $("bom-show-price");
  if (bomPriceBox) {
    bomPriceBox.checked = bomShowPrice;
    bomPriceBox.addEventListener("change", () => {
      bomShowPrice = bomPriceBox.checked;
      localStorage.setItem(BOM_PRICE_KEY, bomShowPrice ? "1" : "0");
      update();
    });
  }
  const BOM_COLOR_KEY = "quadro.bomByColor.v1";
  let bomByColor = localStorage.getItem(BOM_COLOR_KEY) === "1";
  const bomColorBox = $("bom-by-color");
  if (bomColorBox) {
    bomColorBox.checked = bomByColor;
    bomColorBox.addEventListener("change", () => {
      bomByColor = bomColorBox.checked;
      localStorage.setItem(BOM_COLOR_KEY, bomByColor ? "1" : "0");
      bomHighlightKey = null;
      builder.setHighlight(null);
      update();
    });
  }


  function update() {
    syncDeleteButton();
    // Der Builder kann den Schraeg-Schalter selbst umlegen (zweiter Klick auf
    // die gewaehlte Kupplung) -- die Toolbar muss das nachziehen.
    syncPartHighlights();
    const bom = computeBOM(model);
    // Stückliste und Bestand stehen in EINER Liste: erst rechnen, welche Teile
    // reichen, dann jede Zeile damit beschriften.
    const cmp = compareInventory(bom, flacherBestand());
    invIndex = new Map(cmp.rows.map((r) => [r.group + ":" + r.key, r]));
    lastInvRows = cmp.rows;
    // Nach Farben getrennt: je Farbe eine eigene Bedarfs-/Bestandszeile.
    if (bomByColor) {
      const farbig = (bucket, rows, idFeld) => {
        for (const r of rows) {
          if (!r.color) continue;
          const key = `${bucket}:${r[idFeld]}|${r.color}`;
          const owned = (inventory[bucket] || {})[`${r[idFeld]}|${r.color}`] || 0;
          invIndex.set(key, { group: bucket, key: `${r[idFeld]}|${r.color}`,
            name: r.name, need: r.count, owned, ok: owned >= r.count });
        }
      };
      farbig("tubes", bom.tubes, "tubeId");
      farbig("panels", bom.panels, "panelId");
      farbig("screws", bom.screws || [], "id");   // farbig ist nur die Rohrschraube
    }

    // Nach Farben getrennt oder zusammengefasst? Der Preis hängt nicht an der
    // Farbe, deshalb lassen sich die Zeilen einfach addieren.
    const nachFarbe = bomByColor;
    const fasseZusammen = (rows, idFeld) => {
      if (nachFarbe) return rows;
      const map = new Map();
      for (const r of rows) {
        const id = r[idFeld];
        if (!map.has(id)) map.set(id, { ...r, color: null, colorName: null, count: 0, subtotal: 0 });
        const z = map.get(id);
        z.count += r.count;
        z.subtotal = round2Preis(z.subtotal + (r.subtotal || 0));
      }
      return [...map.values()];
    };

    // Bearbeiten: jede Kategorie zeigt den ganzen Katalog, damit sich auch
    // Bestand für Teile eintragen lässt, die im Modell (noch) nicht vorkommen.
    if (bomEditMode) { renderBestand(); return; }

    const tb = $("bom-tubes"); tb.innerHTML = "";
    const rohre = fasseZusammen(bom.tubes, "tubeId");
    bomAbschnitt("bom-tubes", rohre.length === 0);
    for (const r of rohre) {
      bomRow(tb, r.color ? `${r.name} · ${r.colorName}` : r.name, r.color, r.count, r.subtotal,
        "tubes:" + r.tubeId + (r.color ? "|" + r.color : ""),
        { kind: "tubes", id: r.tubeId, color: r.color }, bomIcon("tubes", r.tubeId));
    }

    const cb = $("bom-connectors"); cb.innerHTML = "";
    bomAbschnitt("bom-connectors", bom.connectors.length === 0 && !bom.openEnds);
    for (const r of bom.connectors) {
      bomRow(cb, r.name, null, r.count, r.subtotal, "connectors:" + r.type,
        { kind: "connectors", id: r.type }, bomIcon("connectors", r.type));
    }
    if (bom.openEnds > 0) {
      // Hinweiszeile, kein Teil: die Zahl steht in derselben Spalte wie die
      // Mengen der übrigen Zeilen, nur ohne "x".
      const row = el("div", "bom-row muted");
      const hinweis = el("span", "bom-name");
      hinweis.appendChild(el("span", "bom-icon"));
      hinweis.appendChild(document.createTextNode(t("bom_open_ends")));
      row.appendChild(hinweis);
      row.appendChild(el("span", "bom-count", String(bom.openEnds)));
      if (bomShowPrice) row.appendChild(el("span", "bom-sub", ""));
      cb.appendChild(row);
    }

    const pb = $("bom-panels"); pb.innerHTML = "";
    const platten = fasseZusammen(bom.panels, "panelId");
    bomAbschnitt("bom-panels", platten.length === 0);
    for (const r of platten) {
      bomRow(pb, r.color ? `${r.name} · ${r.colorName}` : r.name, r.color, r.count, r.subtotal,
        "panels:" + r.panelId + (r.color ? "|" + r.color : ""),
        { kind: "panels", id: r.panelId, color: r.color }, bomIcon("panels", r.panelId));
    }

    const xb = $("bom-textiles"); xb.innerHTML = "";
    const textiles = bom.textiles || [];
    for (const r of textiles) {
      const name = `${t("bom_textile")} ${r.w}×${r.h} cm` + (nachFarbe ? ` · ${r.colorName}` : "");
      bomRow(xb, name, nachFarbe ? r.color : null, r.count, null, null,
        { kind: "textiles", id: `${r.w}x${r.h}`, color: nachFarbe ? r.color : null },
        bomIcon("textiles"));
    }

    const slb = $("bom-slides"); slb.innerHTML = "";
    const slides = bom.slides || [];
    bomAbschnitt("bom-slides", slides.length === 0);
    for (const r of slides) {
      bomRow(slb, r.name || slideKindName(r.kind), null, r.count, r.subtotal || null,
        r.id ? "fittings:" + r.id : null, { kind: "slides", id: r.kind },
        bomIcon("slides", r.kind, r.kind));
    }

    // Zubehör auf Textilien, Räder und Anbauteile verteilen.
    const fits = bom.fittings || [];
    const rad = $("bom-wheels"); rad.innerHTML = "";
    const fb = $("bom-fittings"); fb.innerHTML = "";
    const ziele = { textiles: xb, wheels: rad, fittings: fb };
    const zaehler = { textiles: textiles.length, wheels: 0, fittings: 0 };
    for (const r of fits) {
      const gruppe = zubehoerGruppe(r.kind);
      zaehler[gruppe]++;
      bomRow(ziele[gruppe], r.name, null, r.count, r.subtotal || null, "fittings:" + r.id,
        { kind: "fittings", id: r.id }, bomIcon("fittings", r.id, r.kind));
    }
    const boxIds = { textiles: "bom-textiles", wheels: "bom-wheels", fittings: "bom-fittings" };
    for (const gruppe of Object.keys(ziele)) bomAbschnitt(boxIds[gruppe], !zaehler[gruppe]);

    const rb = $("bom-reinforcements"); rb.innerHTML = "";
    const reinf = bom.reinforcements || [];
    bomAbschnitt("bom-reinforcements", reinf.length === 0);
    for (const r of reinf) bomRow(rb, r.name, null, r.count, r.subtotal, "reinforcements:" + r.id,
      { kind: "reinforcements", id: r.id }, bomIcon("reinforcements", r.id));

    // Schrauben: nur gerechnet -- kein Bestand (kein invKey) und nichts zum
    // Hervorheben (kein hl), im Modell gibt es sie ja nicht.
    const sb = $("bom-screws"); sb.innerHTML = "";
    const schrauben = bom.screws || [];
    bomAbschnitt("bom-screws", !schrauben.length);
    // Rohrschrauben gibt es in den Rohrfarben; ohne Farbtrennung stehen sie in
    // einer Summenzeile, genau wie Rohre und Platten.
    const schraubenZeilen = fasseZusammen(schrauben, "id");
    for (const r of schraubenZeilen) {
      const name = r.colorName ? `${r.name} · ${r.colorName}` : r.name;
      // Mit Bestandsbezug: die Zeile zeigt "vorhanden/benötigt" und wird rot,
      // wenn es nicht reicht. Hervorheben lässt sich nichts -- im Modell gibt
      // es die Schrauben nicht.
      bomRow(sb, name, r.color || null, r.count, r.subtotal,
        "screws:" + r.id + (r.color ? "|" + r.color : ""), null, bomIcon("screws", r.id));
    }

    $("sum-tubes").textContent = bom.totals.tubes;
    $("sum-conn").textContent = bom.totals.connectors;
    $("sum-panels").textContent = bom.totals.panels;
    $("sum-screws").textContent = bom.totals.screws || 0;
    $("sum-other").textContent = bom.totals.other || 0;
    $("sum-price").textContent = eur(bom.totals.price);

    renderInventory(bom);
    // Die Bibliothek zeigt je Modell, ob der Bestand reicht -- nach einer
    // Bestandsaenderung muessen die Haken neu gerechnet werden.
    if (currentPanel === "library") renderLibrary();
    if (currentPanel === "own") renderOwnModels();
    if (builder.mode === "assembly") renderAssembly();
  }

  /** Aussenmasse des Modells (Hoehe/Breite/Tiefe) ueber der Bestandsliste. */
  function renderModelSize() {
    const box = $("model-size");
    if (!box) return;
    // Halbe Kupplung an jeder Seite: die Wuerfel stehen ueber die Eckknoten
    // hinaus, das Mass waere sonst um eine Kupplungslaenge zu klein.
    const b = model.bounds(geometry().connectorSize / 2);
    if (!b) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = "";
    const dims = [["dim_height", b.size[1]], ["dim_width", b.size[0]], ["dim_depth", b.size[2]]];
    for (const [key, v] of dims) {
      const cell = el("div", "dim");
      cell.appendChild(el("span", "dim-label", t(key)));
      cell.appendChild(el("span", "dim-value", `${Math.round(v)} cm`));
      box.appendChild(cell);
    }
  }

  // Welche Bestandszeile ist gerade hervorgehoben ("group:key" oder null)?
  let invHighlightKey = null;

  /** Teile im Modell, die zu einer Bestandszeile gehoeren. */
  function partsForInventoryRow(r) {
    const ids = new Set();
    if (r.group === "tubes") {
      for (const t of model.tubes.values())
        if (!t.arm && !t.link && t.tubeId === r.key) ids.add(t.id);
    } else if (r.group === "panels") {
      for (const p of model.panels.values()) if (p.panelId === r.key) ids.add(p.id);
    } else if (r.group === "connectors") {
      for (const n of model.nodes.values())
        if (connectorsForNode(model, n).includes(r.key)) ids.add(n.id);
      // Doppelrohrverbinder haengen nicht an Knoten, sondern sind eigene Teile.
      for (const c of (model.clamps ? model.clamps.values() : []))
        if ((c.connectorId || "double_tube") === r.key) ids.add(c.id);
    } else if (r.group === "reinforcements") {
      for (const t of model.tubes.values()) if (t.reinforced) ids.add(t.id);
    } else if (r.group === "fittings") {
      for (const id of fittingsForPart(r.key)) ids.add(id);
    }
    // "screws" bleibt leer: Schrauben werden gerechnet, nicht gebaut.
    return ids;
  }

  // Die Bestandsliste ist Teil der Stückliste; die Hervorhebung läuft über
  // setBomHighlight. Bleibt für den Aufruf aus der Machbarkeitsprüfung.
  function setInventoryHighlight(r) {
    invHighlightKey = r ? r.group + ":" + r.key : null;
    builder.setHighlight(r ? partsForInventoryRow(r) : null);
  }

  let lastInvRows = [];

  /**
   * Bearbeiten-Ansicht: dieselben Abschnitte, aber der volle Katalog und je
   * Zeile ein Eingabefeld für den eigenen Bestand.
   */
  function renderBestand() {
    const zubehoer = accessories();
    const istRutsche = (a) => typeof a.qdf === "string" && /slide/.test(a.qdf);
    const ausGruppe = (name) => zubehoer.filter((a) => !istRutsche(a) && zubehoerGruppe(a.qdf) === name);
    // `stock: false` heisst: das Teil gibt es, es laesst sich aber nicht
    // bevorraten -- weil kein Modell es je anfordert. Die gelochten Rohre kann
    // die QDF-Datei nicht ausdruecken (dort steht nur eine Laenge), und das
    // offene Verbinderende ist ein Vermerk an einer Kupplung, kein Bauteil.
    const lager = (liste) => liste.filter((x) => x && x.stock !== false);
    const abschnitte = [
      ["bom-tubes", "tubes", lager(allTubes())],
      ["bom-connectors", "connectors", lager(allConnectors())],
      ["bom-panels", "panels", lager(panels())],
      ["bom-textiles", "fittings", lager(ausGruppe("textiles"))],
      ["bom-slides", "fittings", lager(zubehoer.filter(istRutsche))],
      ["bom-wheels", "fittings", lager(ausGruppe("wheels"))],
      ["bom-fittings", "fittings", lager(ausGruppe("fittings"))],
      ["bom-reinforcements", "reinforcements", lager(reinforcements())],
      ["bom-screws", "screws", lager(screws())],
    ];
    // Farbige Teile bekommen je Farbe eine eigene Zeile, sobald die Liste nach
    // Farben getrennt ist -- sonst ließe sich der Bestand nicht farbgenau
    // eintragen. Farbig sind Rohre und Platten (Platten zusätzlich schwarz).
    const farbigeToepfe = { tubes: tubeColors(), panels: [...tubeColors(), ...PANEL_EXTRA_COLORS],
      screws: tubeColors() };
    for (const [boxId, bucket, teile] of abschnitte) {
      // Beim Bearbeiten steht jeder Abschnitt da -- auch für Teile, die im
      // Modell (noch) nicht vorkommen; nur so lässt sich Bestand eintragen.
      const box = bomAbschnitt(boxId, false);
      box.innerHTML = "";
      if (!teile.length) { box.appendChild(el("div", "muted", "–")); continue; }
      for (const it of teile) {
        // Bei den Schrauben ist nur die Rohrschraube farbig -- die uebrigen
        // gibt es nur schwarz. Deshalb entscheidet hier das TEIL, nicht der
        // Abschnitt.
        const farben = bomByColor && (bucket !== "screws" || it.colored)
          ? farbigeToepfe[bucket] : null;
        // Nur der Name -- die Katalog-Kennung (CH1, CBR ...) sagt beim Eintragen
        // nichts und machte die Zeilen unnoetig lang.
        const name = partName(it);
        // Dasselbe Sinnbild wie in der Stückliste; Zubehör wird über seine
        // QDF-Art nachgeschlagen, alles andere über die Teile-Kennung.
        const icon = bomIcon(bucket, it.id, it.qdf);
        if (farben) {
          for (const f of farben) {
            const farbName = (getLang() === "en" && f.name_en) ? f.name_en : f.name;
            bomRow(box, `${name} · ${farbName}`, f.id, 0, null, `${bucket}:${it.id}|${f.id}`, null, icon);
          }
        } else {
          bomRow(box, name, null, 0, null, `${bucket}:${it.id}`, null, icon);
        }
      }
    }
  }

  /** Kopf des vereinten Panels: Modellmaße und Machbarkeit. */
  function renderInventory(bom) {
    renderModelSize();
    const banner = $("feasibility-banner");
    if (bom.totals.tubes === 0 && bom.totals.connectors === 0 && bom.totals.panels === 0) {
      banner.className = "feasibility";
      banner.textContent = "";
      lastInvRows = [];
      if (invHighlightKey) { invHighlightKey = null; builder.setHighlight(null); }
      return;
    }
    const cmp = compareInventory(bom, inventory);
    // Hervorhebung nachziehen: das Modell kann sich geändert haben.
    const nochDa = cmp.rows.find((r) => r.group + ":" + r.key === invHighlightKey);
    if (invHighlightKey) {
      if (nochDa) builder.highlight = partsForInventoryRow(nochDa);
      else { invHighlightKey = null; builder.highlight = null; }
    }
    banner.className = "feasibility " + (cmp.feasible ? "ok" : "no");
    banner.textContent = cmp.feasible ? t("inv_feasible") : t("inv_infeasible");
  }



  function exportInventory() {
    storage.exportFile(
      { format: "quadro-inventory", version: 1,
        tubes: inventory.tubes, connectors: inventory.connectors,
        panels: inventory.panels, reinforcements: inventory.reinforcements,
        screws: inventory.screws },
      "quadro-bestand.json",
    );
    flash(t("flash_inv_exported"));
  }

  function sanitizeInventory(data) {
    if (!data || typeof data !== "object") throw new Error(t("inv_invalid"));
    const out = { tubes: {}, connectors: {}, panels: {}, reinforcements: {}, screws: {} };
    for (const bucket of ["tubes", "connectors", "panels", "reinforcements", "screws"]) {
      const src = data[bucket];
      if (src && typeof src === "object") {
        for (const [k, raw] of Object.entries(src)) {
          const n = Math.max(0, parseInt(raw, 10) || 0);
          if (n) out[bucket][k] = n;
        }
      }
    }
    return out;
  }

  async function importInventory(file) {
    try {
      const data = await storage.importFile(file);
      const next = sanitizeInventory(data);
      inventory.tubes = next.tubes;
      inventory.connectors = next.connectors;
      inventory.panels = next.panels;
      inventory.reinforcements = next.reinforcements;
      inventory.screws = next.screws;
      saveInv(inventory);
      sync.nudge();
      update();
      flash(t("flash_inv_imported"));
    } catch (err) { showMessage(err.message); }
  }

  $("btn-inv-toggle").addEventListener("click", () => {
    if (bomEditMode) {
      // Speichern: Eingaben stehen schon im Bestand, jetzt festschreiben.
      saveInv(inventory);
      sync.nudge();
      bomEditMode = false;
      flash(t("flash_inv_saved"));
    } else {
      bomEditMode = true;
      bomHighlightKey = null;
      builder.setHighlight(null);
    }
    const knopf = $("btn-inv-toggle");
    knopf.textContent = t(bomEditMode ? "btn_inv_save" : "btn_inv_edit");
    knopf.classList.toggle("active", bomEditMode);
    update();
  });

  $("btn-inv-export").addEventListener("click", exportInventory);
  $("btn-inv-import").addEventListener("click", () => $("inv-file-import").click());
  $("inv-file-import").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) importInventory(f);
    e.target.value = "";
  });

  // Die Datei-Handler oben greifen auf diese Sammlung zu; sie wird unten
  // gefüllt (Tabs, aktiver Tab, Sichern).
  const ui = {};

  // --- Dateien in Tabs ---------------------------------------------------
  // Ein Tab hält ein Modell samt seiner Werkzeugleiste, Ansicht und Schritt-
  // speicher. Umgeschaltet wird über EIN Modell und EINEN Builder: der Stand
  // des alten Tabs wird gesichert, der des neuen eingesetzt.
  let tabs = [];            // { tabId, docId, name, dirty, model, view }
  let activeTabId = null;
  let sessionTimer = null;
  // Während ein Tab eingesetzt wird, laufen Änderungsmeldungen des Builders
  // auf -- die gehören nicht zum Bearbeiten und dürfen den Tab nicht als
  // geändert markieren (sonst blitzt beim Wechsel kurz der Punkt auf).
  let ladeVorgang = false;

  function activeTab() { return tabs.find((x) => x.tabId === activeTabId) || null; }

  /** Ansicht und Werkzeugleiste des laufenden Tabs einsammeln. */
  function viewState() {
    return {
      ...builder.uiState(),
      slice: JSON.parse(JSON.stringify(slice)),
      camera: scene.cameraState() || null,
      projection: scene.projection,
    };
  }

  function applyViewState(v = {}) {
    builder.setUiState(v);
    if (v.slice && ["x", "y", "z"].includes(v.slice.axis)) {
      Object.assign(slice, { on: !!v.slice.on, axis: v.slice.axis, value: v.slice.value || 0,
        flip: !!v.slice.flip, values: { ...slice.values, ...(v.slice.values || {}) } });
    } else {
      slice.on = false;
    }
    setMode(v.mode || "select");     // setzt auch die Knöpfe
    if (v.projection && v.projection !== scene.projection) {
      scene.setProjection(v.projection);
      syncProjectionButton();
    }
    applySlice();
    syncPartHighlights();
    if (v.camera) scene.restoreCameraState(v.camera); else scene.resetCamera(model);
    renderColorButtons();
    updateUndoButton();
  }

  /** Stand des laufenden Tabs festhalten (vor jedem Wechsel und vor dem Sichern). */
  function captureActiveTab() {
    const tab = activeTab();
    if (!tab) return null;
    // Eine Kopie am Zeiger steckt zwar im Modell, ist aber noch nicht
    // abgesetzt: gesichert wird der Stand davor, sonst landete die Vorschau in
    // der Sitzung oder in der Datei.
    tab.model = builder.pasteSnapshot() || model.toJSON();
    tab.view = viewState();
    // Auch beim Tab-Wechsel: die Ansicht gehört zu diesem Fenster.
    merkeFensterKamera(tab.tabId, tab.view.camera);
    return tab;
  }

  // --- Tabs umsortieren (nur waagerecht) ---------------------------------
  // Gezogen wird mit Zeigerereignissen, damit es auch auf dem Touchscreen
  // funktioniert. Die Reihenfolge ändert sich schon während des Ziehens: sobald
  // der Zeiger die Mitte eines Nachbarn überschreitet, tauschen die beiden.
  let zieh = null;   // { tabId, startX, gestartet, gezogen }

  function beginneZiehen(tabId, startX) {
    zieh = { tabId, startX, gestartet: false, gezogen: false };
    document.addEventListener("pointermove", beimZiehen);
    document.addEventListener("pointerup", beendeZiehen, { once: true });
    document.addEventListener("pointercancel", beendeZiehen, { once: true });
  }

  function beimZiehen(e) {
    if (!zieh) return;
    if (!zieh.gestartet) {
      if (Math.abs(e.clientX - zieh.startX) < 5) return;   // noch ein Klick
      zieh.gestartet = true;
      zieh.gezogen = true;
      document.body.classList.add("tab-dragging");
      renderTabs();
    }
    const list = $("tab-list");
    const elemente = [...list.querySelectorAll(".tab")];
    const von = tabs.findIndex((x) => x.tabId === zieh.tabId);
    if (von < 0) return;
    // Ziel: der Tab, über dessen Mitte der Zeiger steht.
    let nach = von;
    elemente.forEach((el2, i) => {
      const r = el2.getBoundingClientRect();
      if (e.clientX > r.left + r.width / 2 && i > nach) nach = i;
      if (e.clientX < r.left + r.width / 2 && i < nach) nach = i;
    });
    if (nach !== von) {
      const [tab] = tabs.splice(von, 1);
      tabs.splice(nach, 0, tab);
      renderTabs();
    }
  }

  function beendeZiehen() {
    document.removeEventListener("pointermove", beimZiehen);
    document.body.classList.remove("tab-dragging");
    if (zieh && zieh.gestartet) {
      renderTabs();
      scheduleSessionSave();
      // Der Klick nach dem Loslassen gehört noch zum Ziehen -- erst danach
      // zählen Klicks wieder als Tab-Wechsel.
      const beendet = zieh;
      setTimeout(() => { if (zieh === beendet) zieh = null; }, 0);
    } else {
      zieh = null;
    }
  }

  function renderTabs() {
    const list = $("tab-list");
    if (!list) return;
    // Mit nur EINEM Entwurf sagt die Leiste nichts, was der Kopf nicht schon
    // zeigt -- im Hochformat ist die Zeile Hoehe wert und faellt dann weg.
    $("tab-bar").classList.toggle("single", tabs.length < 2);
    list.innerHTML = "";
    for (const tab of tabs) {
      const item = el("div", "tab" + (tab.tabId === activeTabId ? " active" : "")
        + (tab.preview ? " preview" : "")
        + (zieh && zieh.gestartet && zieh.tabId === tab.tabId ? " dragging" : ""));
      item.dataset.tabId = tab.tabId;
      item.title = tab.name;
      // Vorschau-Tabs zeigen keinen Änderungs-Punkt: sobald jemand darin baut,
      // sind sie keine Vorschau mehr (siehe evaluateDirty).
      if (tab.dirty && !tab.preview) item.appendChild(el("span", "tab-dirty"));
      item.appendChild(el("span", "tab-name", tab.name));
      const zu = el("button", "tab-close", "×");
      zu.title = t("btn_doc_close");
      zu.addEventListener("click", (e) => { e.stopPropagation(); closeTab(tab.tabId); });
      item.appendChild(zu);
      item.addEventListener("click", () => {
        if (zieh && zieh.gezogen) return;    // war ein Umsortieren, kein Klick
        activateTab(tab.tabId);
      });
      item.addEventListener("dblclick", () => pinTab(tab));
      // Mittelklick schliesst -- die gewohnte Geste aus Browsern und Editoren.
      item.addEventListener("auxclick", (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        closeTab(tab.tabId);
      });
      item.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest(".tab-close")) return;
        beginneZiehen(tab.tabId, e.clientX);
      });
      list.appendChild(item);
    }
    // Ohne offenes Modell tritt der Einstieg an die Stelle der Szene.
    document.body.classList.toggle("no-doc", tabs.length === 0);
    const leer = $("empty-state");
    if (leer) leer.hidden = tabs.length > 0;
  }

  function activateTab(tabId) {
    if (tabId === activeTabId) return;
    // Ein Tab-Wechsel beendet ein laufendes Einfuegen -- die Kopie gehoert zu
    // diesem Modell, nicht zum naechsten. Die Zwischenablage bleibt.
    builder.cancelPaste();
    captureActiveTab();
    const tab = tabs.find((x) => x.tabId === tabId);
    if (!tab) return;
    activeTabId = tabId;
    ladeVorgang = true;
    builder.modelReplaced();
    model.loadJSON(tab.model || { format: 1, nodes: [], tubes: [] });
    applyViewState(tab.view || {});
    builder.refresh();
    ladeVorgang = false;
    renderTabs();
    update();
    scheduleSessionSave();
  }

  /**
   * Neuen Tab anlegen und öffnen. `view` gibt den Startzustand vor -- ein neues
   * Modell startet im Bau-Modus mit einem 35er Rohr, ein geöffnetes oder
   * importiertes im Auswahl-Modus.
   */
  function openTab({ name, data, docId = null, view = null, preview = false }) {
    builder.cancelPaste();
    captureActiveTab();
    // Nur EIN Vorschau-Tab: der vorige war unberührt und macht Platz.
    if (preview) discardPreview();
    const tab = {
      tabId: docs.newTabId(), docId, name: name || t("doc_untitled"), dirty: false, preview,
      model: data || { format: 1, nodes: [], tubes: [] },
      view: view || defaultView(!data),
    };
    tabs.push(tab);
    activeTabId = tab.tabId;
    ladeVorgang = true;
    builder.modelReplaced();
    model.loadJSON(tab.model);
    applyViewState(tab.view);
    builder.refresh();
    ladeVorgang = false;
    // Vergleichsstand NACH dem Laden nehmen: der Änderungs-Punkt vergleicht
    // spaeter mit `model.toJSON()`, und das steht nicht Zeichen fuer Zeichen so
    // da wie die hereingereichten Daten (Import, Bibliothek, aeltere Staende).
    // Sonst gilt ein Modell als geaendert, kaum dass man die Ansicht dreht.
    //
    // Der Punkt zeigt AUSSCHLIESSLICH an, dass jemand am Modell gearbeitet hat
    // -- genau das, was auch im Rueckgaengig-Verlauf steht. Dass ein Modell noch
    // in keiner Datei liegt, sagt nicht der Punkt, sondern die Nachfrage beim
    // Schliessen (siehe closeTab).
    const stand = JSON.stringify(model.toJSON());
    tab.model = JSON.parse(stand);
    tab.savedJson = stand;
    // Stand beim Öffnen: daran erkennt der Vorschau-Tab, dass jemand wirklich
    // gebaut hat -- dann bleibt er stehen.
    tab.baseJson = stand;
    renderTabs();
    update();
    scheduleSessionSave();
    return tab;
  }

  /**
   * Vorschau-Tabs (wie in VS Code): ein Klick in der Liste öffnet das Modell
   * nur zum Ansehen -- der nächste Klick ersetzt es. Wer darin baut oder es
   * doppelt anklickt, behält den Tab.
   */
  function discardPreview() {
    const i = tabs.findIndex((x) => x.preview);
    if (i < 0) return;
    const [weg] = tabs.splice(i, 1);
    if (weg.tabId === activeTabId) activeTabId = null;
    renderTabs();
    scheduleSessionSave();
  }

  /** Vorschau-Tab dauerhaft machen. */
  function pinTab(tab) {
    if (!tab || !tab.preview) return;
    tab.preview = false;
    renderTabs();
    scheduleSessionSave();
  }

  /** Startzustand: leeres Modell -> bauen mit 35er Rohr und zufälliger Farbe. */
  function defaultView(leer) {
    const st = builder.uiState();
    st.undo = []; st.redo = [];
    st.slice = { on: false, axis: "z", value: 0, flip: false, values: { x: null, y: null, z: null } };
    st.camera = null;
    if (leer) {
      st.mode = "add";
      st.tubeId = geometry().defaultTube;
      st.color = RANDOM_COLOR;
    } else {
      st.mode = "select";
    }
    return st;
  }

  /**
   * Rückfrage vor dem Schließen: Speichern, Verwerfen oder Abbrechen.
   * Liefert "save" | "discard" | "cancel".
   */
  function askUnsaved(name) {
    return dialog({
      title: t("ask_close_title"),
      text: t("ask_close_text", name),
      cancelKey: "cancel",
      buttons: [
        { key: "save", label: t("ask_save") },
        { key: "discard", label: t("ask_discard"), kind: "ghost" },
        { key: "cancel", label: t("ask_cancel"), kind: "ghost" },
      ],
    }).then((r) => (r ? r.key : "cancel"));
  }

  async function closeTab(tabId) {
    const i = tabs.findIndex((x) => x.tabId === tabId);
    if (i < 0) return;
    const tab = tabs[i];
    // Ungespeicherte Änderungen: nachfragen. Bei eingeschaltetem Auto-Save gilt
    // ein Tab mit Datei als gespeichert -- dort läuft der Stand ohnehin mit.
    // Eine Vorschau hat nichts zu verlieren: sie geht wortlos zu.
    // Gefragt wird auch bei einem Tab OHNE Datei, in dem etwas steht: ein
    // importiertes Modell waere sonst mit dem Schliessen weg, obwohl niemand
    // daran gebaut hat (und der Punkt deshalb fehlt).
    const inhalt = tabId === activeTabId
      ? model.nodes.size > 0
      : !!(tab.model && (tab.model.nodes || []).length);
    const nurSitzung = !tab.docId && inhalt;
    const offen = (tab.dirty || nurSitzung) && !tab.preview && !(autosaveOn && tab.docId);
    if (offen) {
      if (tabId !== activeTabId) activateTab(tabId);
      const antwort = await askUnsaved(tab.name);
      if (antwort === "cancel") return;
      if (antwort === "save") {
        if (!tab.docId) {
          const gewaehlt = await askName(tab.name);
          if (!gewaehlt) return;
          await saveActiveTab({ name: gewaehlt.name, docId: gewaehlt.doc ? gewaehlt.doc.id : null });
        } else {
          await saveActiveTab();
        }
      }
    }
    if (tabId === activeTabId) captureActiveTab();
    tabs.splice(i, 1);
    if (tabId === activeTabId) {
      activeTabId = null;
      const naechster = tabs[i] || tabs[i - 1] || null;
      ladeVorgang = true;
      if (naechster) {
        activeTabId = naechster.tabId;
        builder.modelReplaced();
        model.loadJSON(naechster.model || { format: 1, nodes: [], tubes: [] });
        applyViewState(naechster.view || {});
        builder.refresh();
      } else {
        builder.modelReplaced();
        model.loadJSON({ format: 1, nodes: [], tubes: [] });
        builder.refresh();
      }
      ladeVorgang = false;
    }
    renderTabs();
    update();
    scheduleSessionSave();
  }

  /**
   * Am laufenden Tab hat sich etwas getan. Der Builder meldet das bei JEDEM
   * Neuzeichnen -- auch bei Auswahl, Schnittebene oder Moduswechsel. Der
   * Änderungs-Punkt gehört aber nur dem MODELL: er hängt deshalb an einem
   * Vergleich mit dem zuletzt gespeicherten Stand (`savedJson`), nicht am
   * Ereignis. Der Vergleich läuft entprellt, damit er nicht bei jedem Klick
   * das ganze Modell serialisiert.
   */
  function touchActiveTab() {
    if (ladeVorgang) return;
    const tab = activeTab();
    if (!tab) return;
    scheduleSessionSave();
    clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(evaluateDirty, 200);
  }

  let dirtyTimer = null;

  function evaluateDirty() {
    const tab = activeTab();
    if (!tab) return;
    if (builder.pasting) return;         // die Vorschau zählt nicht als Änderung
    // Ohne bekannten Vergleichsstand (importiert, aus der Bibliothek geöffnet)
    // bleibt der Tab ungespeichert, bis er einmal in eine Datei geht.
    if (tab.savedJson == null && !(tab.preview && tab.baseJson != null)) return;
    const current = JSON.stringify(model.toJSON());
    let neuZeichnen = false;
    // Wer in einer Vorschau baut, will sie behalten.
    if (tab.preview && tab.baseJson != null && current !== tab.baseJson) {
      tab.preview = false;
      neuZeichnen = true;
    }
    if (tab.savedJson != null) {
      const changed = current !== tab.savedJson;
      if (changed !== tab.dirty) {
        tab.dirty = changed;
        neuZeichnen = true;
        // Auto-Save schreibt direkt in die Datei; ist er aus, bleibt der Stand
        // nur in der Sitzung (überlebt einen Reload, gilt aber als ungespeichert).
        if (changed && tab.docId) scheduleDocSave();
      }
    }
    if (!neuZeichnen) return;
    renderTabs();
    scheduleSessionSave();
  }

  function scheduleSessionSave() {
    // Wie beim Speichern: während des Einfügens bleibt die Sitzung, wie sie ist.
    if (builder.pasting) return;
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => {
      captureActiveTab();
      // `savedJson` bleibt draußen: es ist eine Kopie des Modells und würde die
      // Sitzung verdoppeln. Beim Start wird es aus `model`/`dirty` neu gebildet.
      const lean = tabs.map(({ savedJson, baseJson, ...rest }) => rest);
      docs.saveSession({ tabs: lean, activeTabId }).catch((e) => console.warn("Sitzung:", e));
    }, 600);
  }

  /** Beim Start: Migration, Sitzung wiederherstellen, sonst leerer Zustand. */
  async function start() {
    try { await docs.migrateOldDrafts(); } catch (e) { console.warn("Migration:", e); }
    let sitzung = null;
    try { sitzung = await docs.loadSession(); } catch (e) { console.warn("Sitzung:", e); }
    if (sitzung && sitzung.tabs.length) {
      tabs = sitzung.tabs;
      // Ein Tab ohne offene Änderung zeigt genau seinen gespeicherten Stand --
      // daran misst sich ab jetzt der Änderungs-Punkt.
      for (const tab of tabs) {
        const json = JSON.stringify(tab.model);
        tab.savedJson = tab.dirty ? null : json;
        tab.baseJson = json;
      }
      activeTabId = sitzung.activeTabId && tabs.some((x) => x.tabId === sitzung.activeTabId)
        ? sitzung.activeTabId : tabs[0].tabId;
      const tab = activeTab();
      ladeVorgang = true;
      builder.modelReplaced();
      model.loadJSON(tab.model || { format: 1, nodes: [], tubes: [] });
      // Sitzungen aus der Zeit vor dem Sichern der Kamera fuehren keinen Stand
      // mit; dann gilt der zuletzt gesehene aus localStorage, statt gleich auf
      // die Standardansicht zurueckzufallen.
      const view = { ...(tab.view || {}) };
      // Die Ansicht DIESES Fensters hat Vorrang: die Sitzung kann inzwischen von
      // einem anderen Fenster überschrieben worden sein.
      const fenster = fensterKameras();
      if (fenster[tab.tabId]) view.camera = fenster[tab.tabId];
      if (!view.camera) {
        try { view.camera = JSON.parse(localStorage.getItem(CAMERA_KEY)) || null; } catch { /* egal */ }
      }
      applyViewState(view);
      builder.refresh();
      ladeVorgang = false;
    } else if (sitzung) {
      // Die Sitzung steht, sie ist nur leer -- alle Tabs waren zu. Dann faengt
      // man mit einem leeren Entwurf an: der alte Autosave gehoert zu einer
      // Sitzung, die es nicht mehr gibt, und kam sonst als "Unbenannt" zurueck.
      openTab({ name: t("doc_untitled") });
    } else {
      // Allererster Start (oder Sitzung weggeraeumt): der alte Autosave aus der
      // Zeit vor den Dateien darf noch einmal auftauchen.
      const alt = storage.loadAutosave();
      openTab({ name: t("doc_untitled"), data: alt && alt.nodes && alt.nodes.length ? alt : null });
    }
    renderTabs();
    update();
  }

  $("tab-new").addEventListener("click", () => openTab({ name: freierName() }));
  $("empty-new").addEventListener("click", () => $("btn-doc-new").click());

  $("empty-open").addEventListener("click", () => { showSidebarPanel("own"); renderOwnModels(); });
  $("empty-import").addEventListener("click", () => $("file-import").click());

  /** "Unbenannt", "Unbenannt 2", ... -- der erste Name, den kein Tab trägt. */
  function freierName() {
    const belegt = new Set(tabs.map((x) => x.name));
    const basis = t("doc_untitled");
    if (!belegt.has(basis)) return basis;
    for (let i = 2; ; i++) if (!belegt.has(`${basis} ${i}`)) return `${basis} ${i}`;
  }

  // --- Layout: schmale Schirme -------------------------------------------
  // Alles Weitere haengt an Klassen auf <body>; CSS und die Umhaenge-Aufrufe
  // lesen nur diese. Zwei Quellen: feste Medienabfragen fuer Geraeteform und
  // Messung fuer die Frage "passt die Bauteil-Zeile noch?".
  const mqPortrait = window.matchMedia("(max-width: 820px) and (orientation: portrait)");
  const mqNarrow = window.matchMedia("(max-width: 1000px)");

  // Kollaps-Stufen der Bauteil-Zeile: 0 = alles ausgeschrieben,
  // 1 = Farben als EIN Knopf, 2 = zusaetzlich die Ansichts-Schalter im Popup.
  let collapseStage = 0;
  // FENSTERbreite, bei der die jeweilige Stufe noetig wurde. Bezugsgroesse ist
  // bewusst nicht die Leiste selbst: das Einklappen aendert deren Breite (die
  // Kopfzeile wird rechts schmaler, also der linke Teil breiter) -- gemessen an
  // ihr schaukelt sich das zu Dauerpendeln auf. Das Fenster liegt fest.
  const tightAt = [0, 0, 0];
  // Sicherheitsabstand oben drauf, damit Rundungen nicht doch noch pendeln.
  const HYSTERESIS = 24;
  // Ruht, solange eine Gruppe im Popup haengt (siehe openGroupPopup).
  let measurePaused = false;

  function applyCollapse() {
    const b = document.body.classList;
    b.toggle("compact-colors", collapseStage >= 1);
    b.toggle("compact-view", collapseStage >= 2);
    $("btn-color").hidden = collapseStage < 1;
    // Im Hochformat stehen Schnittebene und Perspektive oben in der Kopfzeile --
    // dann gibt es hier nichts mehr aufzuklappen.
    $("btn-view").hidden = collapseStage < 2 || mqPortrait.matches;
    // Was gerade offen ist, koennte umgehaengt worden sein -> zumachen.
    closePopup();
    paintColorButton();
    tidyDividers();
  }

  /** Passt die Bauteil-Gruppe noch in die Zeile? */
  function overflows() {
    const grp = $("grp-build");
    return grp.scrollWidth > grp.clientWidth + 1;
  }

  function measureCollapse() {
    if (measurePaused) return;
    if (!$("toolbar-ctx").clientWidth) return;  // unsichtbar (etwa waehrend des Starts)
    const breite = window.innerWidth;
    // Je Durchgang EINE Stufe. Danach gleich noch einmal messen: das Einklappen
    // aendert nur die INNERE Breite der Bauteil-Gruppe, der Beobachter an der
    // Zeile meldet sich dafuer nicht -- ohne die Wiederholung bliebe es bei
    // Stufe 1, obwohl es immer noch zu eng ist.
    if (overflows() && collapseStage < 2) {
      const vorher = $("grp-build").scrollWidth;
      collapseStage++;
      applyCollapse();
      // Wie viel Platz hat dieser Schritt gebracht? Genau so viel muss das
      // Fenster spaeter wieder breiter sein, sonst klappt es sofort zurueck
      // und wieder zu -- ein sichtbares Zucken bei jeder Zwischenbreite.
      tightAt[collapseStage] = breite + Math.max(0, vorher - $("grp-build").scrollWidth);
      requestAnimationFrame(measureCollapse);
      return;
    }
    if (!overflows() && collapseStage > 0 && breite > tightAt[collapseStage] + HYSTERESIS) {
      collapseStage--;
      applyCollapse();
      // Passt es doch nicht, faengt der naechste Durchgang es wieder ein; er
      // merkt sich dann diese Breite und laesst es dabei bewenden.
      requestAnimationFrame(measureCollapse);
    }
  }

  // Kopfzeile: bei Platzmangel bleiben nur Datei, Zurueck und Wieder stehen.
  // Bauen/Aufbau und "Automatisch speichern" wandern ins Menue, der
  // Seitenleisten-Schalter direkt neben den Menue-Knopf.
  let headCompact = false;
  // Stufen der Kopfzeile: 0 = alles ausgeschrieben, 1 = "Automatisch speichern"
  // nur noch als Kasten, 2 = alles ausser Datei/Zurueck/Wieder im Menue.
  // Danach gibt die Marke Stueck fuer Stueck nach: 3 = ohne "3D", 4 = nur noch
  // das Zeichen, 5 = das Zeichen kleiner. Erst schwindet also Text, dann Groesse.
  let headStage = 0;
  const HEAD_STAGE_MAX = 5;
  const headTightAt = [0, 0, 0, 0, 0, 0];

  function applyHeadCollapse(compact) {
    if (compact === headCompact) return;
    headCompact = compact;
    document.body.classList.toggle("compact-head", compact);
    moveNode($("mode-add").parentNode, compact ? $("menu-extra") : null);
    moveNode(document.querySelector(".autosave-toggle"), compact ? $("menu-extra") : null);
    if (compact) $("toolbar-right").insertBefore($("toggle-sidebar"), $("btn-hamburger"));
    else moveNode($("toggle-sidebar"), null);
    if (!compact) toggleHamburger(false);
    tidyDividers();
  }

  function applyHeadStage() {
    document.body.classList.toggle("compact-autosave", headStage >= 1);
    applyHeadCollapse(headStage >= 2);
    document.body.classList.toggle("head-hide-3d", headStage >= 3);
    document.body.classList.toggle("head-hide-name", headStage >= 4);
    document.body.classList.toggle("compact-brand", headStage >= 5);
  }

  function measureHead() {
    // Im Hochformat ist die Kopfzeile IMMER die kompakte: dort faellt der
    // Datei-Knopf weg und seine Eintraege stehen im Menue. Ohne diese Regel
    // haette ein breites Hochformat (Tablet, ~800 px) die Menue-Zeilen offen in
    // der Leiste stehen -- das Menue selbst wird ja erst mit compact-head zum
    // Ausklapp-Feld.
    // Im Hochformat ist Stufe 2 die unterste; die Marke gibt darueber hinaus
    // aber genauso nach, wenn es eng wird.
    const minStage = mqPortrait.matches ? 2 : 0;
    if (headStage < minStage) { headStage = minStage; applyHeadStage(); }
    const left = $("toolbar-left");
    if (!left.clientWidth) return;
    const breite = window.innerWidth;
    // Die Knoepfe schrumpfen nicht mehr (flex-shrink: 0), die Zeile laeuft
    // stattdessen ueber -- daran erkennt man den Platzmangel.
    const eng = left.scrollWidth > left.clientWidth + 1;
    if (eng && headStage < HEAD_STAGE_MAX) {
      const vorher = left.scrollWidth;
      headStage++;
      applyHeadStage();
      headTightAt[headStage] = breite + Math.max(0, vorher - left.scrollWidth);
      requestAnimationFrame(measureHead);
      return;
    }
    if (!eng && headStage > minStage && breite > headTightAt[headStage] + HYSTERESIS) {
      headStage--;
      applyHeadStage();
      requestAnimationFrame(measureHead);
    }
  }

  /**
   * Trenner aufraeumen. Wandern Knoepfe ins Menue oder in ein Popup, bleiben
   * sonst Trenner am Rand oder gleich zwei nebeneinander stehen. Sichtbar
   * bleibt nur, was wirklich zwei Gruppen trennt.
   */
  function tidyDividers() {
    for (const leiste of [$("toolbar-left"), $("toolbar-ctx"), $("grp-build")]) {
      let vorherInhalt = false;     // stand vor diesem Trenner schon etwas?
      let offen = null;             // Trenner, der noch einen Nachfolger sucht
      for (const kind of leiste.children) {
        if (kind.classList.contains("divider")) {
          // Der Loesch-Trenner hat seine eigene Sichtbarkeit (mit der Auswahl).
          if (kind.id === "delete-divider") continue;
          kind.classList.toggle("divider-off", !vorherInhalt);
          if (vorherInhalt) { offen = kind; vorherInhalt = false; }
          continue;
        }
        if (kind.hidden || kind.offsetParent === null) continue;
        vorherInhalt = true;
        offen = null;
      }
      // Am Ende noch ein offener Trenner? Der trennt nichts mehr.
      if (offen) offen.classList.add("divider-off");
    }
  }

  function applyLayout() {
    const hochformat = mqPortrait.matches;
    document.body.classList.toggle("mobile-portrait", hochformat);
    document.body.classList.toggle("sidebar-overlay", mqNarrow.matches || hochformat);
    // Steht die Bauteil-Zeile unten, gehoeren Schnittebene und Perspektive nach
    // oben -- unten bleibt die Farbauswahl. Ein Trenner haelt sie vom
    // Seitenleisten-Schalter ab.
    moveNode($("btn-slice"), hochformat ? $("view-mobile") : null);
    moveNode($("btn-projection"), hochformat ? $("view-mobile") : null);
    $("view-divider").hidden = !hochformat;
    // Die Gruppe, aus der sie kommen, bleibt sonst als leerer Kasten stehen --
    // sie enthaelt nur diese beiden Knoepfe (und die Heimat-Markierungen von
    // moveNode, weshalb CSS-:empty nicht greift).
    const ansichtGruppe = document.querySelector("#toolbar-ctx .view-row");
    if (ansichtGruppe) ansichtGruppe.hidden = hochformat;
    if (hochformat) $("btn-view").hidden = true;
    // Im Hochformat verschwindet der Datei-Knopf; seine Eintraege stehen dann
    // oben im Hauptmenue, das auch ein Tipp auf die Marke oeffnet.
    renderMenuFileRows(hochformat);
    applyPanelVisibility();
    applyAssemblySheet();
    requestAnimationFrame(() => {
      measureCollapse(); measureHead(); tidyDividers(); syncCubeInset(); scene.onResize();
    });
  }

  for (const mq of [mqPortrait, mqNarrow]) mq.addEventListener("change", applyLayout);
  // Der Beobachter deckt alles ab, was die Zeile enger macht: Fensterbreite,
  // Seitenleiste, Sprachwechsel, neue Bauteil-Gruppen.
  new ResizeObserver(() => measureCollapse()).observe($("toolbar-ctx"));
  new ResizeObserver(() => measureHead()).observe($("toolbar-left"));

  // Seitenleiste im Overlay-Modus: Klick daneben oder auf das Kreuz schliesst sie.
  $("sidebar-backdrop").addEventListener("click", () => showSidebarPanel(null));
  $("sidebar-close").addEventListener("click", () => showSidebarPanel(null));

  // --- Aufbau im Hochformat: Karte ueber der Szene -----------------------
  // Das Aufbau-Panel wandert aus der Seitenleiste in eine Karte am unteren
  // Rand. Es bleibt derselbe Knoten -- renderAssembly() und alle IDs merken
  // nichts davon. Eingeklappt zeigt die Karte nur Schrittzahl und Titel.
  let sheetOpen = false;

  function applyAssemblySheet() {
    // Sobald die Seitenleiste ueberlagert, waere sie im Aufbau-Modus im Weg --
    // dann uebernimmt die Karte.
    const inSheet = document.body.classList.contains("sidebar-overlay")
      && builder.mode === "assembly";
    moveNode($("panel-assembly"), inSheet ? $("asm-sheet-body") : null);
    $("asm-sheet").hidden = !inSheet;
    document.body.classList.toggle("asm-sheet-on", inSheet);
    $("asm-sheet").classList.toggle("open", sheetOpen);
    // In der Karte ist das Panel immer sichtbar; zurueck in der Leiste gilt
    // wieder deren Auswahl (sonst stuende der Aufbau unter der Stueckliste).
    $("panel-assembly").hidden = inSheet ? false : currentPanel !== "assembly";
    renderSideTabs();
    if (inSheet) {
      // Erst ohne feste Hoehe messen, dann den Ruhezustand ohne Animation setzen.
      $("asm-sheet").style.height = "";
      peekPx = 0;
      requestAnimationFrame(() => { measurePeek(); setSheetOpen(sheetOpen, false); });
    }
    requestAnimationFrame(() => scene.onResize());
  }

  // Die Statuszeile steht ueber der Karte, nicht darunter -- dafuer braucht das
  // CSS ihre Hoehe. Ein Beobachter meldet jeden Stand: auf, zu und jede
  // Zwischenhoehe waehrend des Ziehens.
  (function watchSheetHeight() {
    const sheet = $("asm-sheet");
    if (!sheet || typeof ResizeObserver === "undefined") return;
    new ResizeObserver(() => {
      root.style.setProperty("--asm-sheet-h", (sheet.hidden ? 0 : sheet.offsetHeight) + "px");
    }).observe(sheet);
  })();

  // Ruhehoehe der eingeklappten Karte (Griff, Schrittzeile, Fortschritt, Titel).
  // Sie haengt am Inhalt und wird deshalb nach jedem Neuaufbau gemessen.
  let peekPx = 0;

  /** Aufgeklappte Hoehe: die halbe Szene. */
  function openPx() {
    return Math.round($("canvas-wrap").getBoundingClientRect().height * 0.5);
  }

  function measurePeek() {
    const sheet = $("asm-sheet");
    if (sheet.hidden || sheetOpen) return;      // nur im Ruhezustand messbar
    const before = sheet.style.height;
    sheet.style.height = "";
    peekPx = sheet.offsetHeight;
    sheet.style.height = before || `${peekPx}px`;
  }

  function setSheetOpen(on, animate = true) {
    sheetOpen = !!on;
    const sheet = $("asm-sheet");
    if (!animate) sheet.classList.add("no-anim");
    sheet.classList.toggle("open", sheetOpen);
    sheet.style.height = `${sheetOpen ? openPx() : (peekPx || sheet.offsetHeight)}px`;
    if (!animate) requestAnimationFrame(() => sheet.classList.remove("no-anim"));
  }

  // Ziehen: auf der GANZEN Karte, nicht nur am Griff. Wer im Listenbereich
  // anfasst, scrollt -- ausser die Liste steht schon ganz oben und der Zug geht
  // nach unten. Dieselbe Geste schliesst damit die Karte, ohne dem Scrollen in
  // die Quere zu kommen.
  const MIN_DRAG = 6;
  let sheetDrag = null;

  /** Zug beginnen. `target` entscheidet, ob er ueberhaupt in Frage kommt. */
  function startSheetDrag(y, target) {
    // Bedienelemente behalten Vorrang -- nur der Griff darf auch ziehen.
    if (target.closest("button, select, input, a") && !target.closest("#asm-sheet-handle")) return;
    sheetDrag = {
      y,
      height: $("asm-sheet").offsetHeight,
      inBody: $("asm-sheet-body").contains(target),
      // Aus der Ruhelage (und am Griff) gehoert die Geste von Anfang an der
      // Karte: der Inhalt ist ausgeblendet, es gibt nichts zu scrollen. Das
      // muss VOR der ersten Bewegung feststehen, sonst reisst der Browser die
      // Geste als Scrollen an sich und gibt sie nicht mehr her.
      owns: !sheetOpen || !!target.closest("#asm-sheet-handle"),
      active: false,
    };
  }

  /**
   * Zug fortsetzen. Liefert true, wenn die Karte ihn uebernommen hat -- dann
   * muss der Aufrufer das Ereignis abfangen, sonst scrollt der Browser mit.
   */
  function moveSheetDrag(y) {
    if (!sheetDrag) return false;
    const dy = y - sheetDrag.y;
    if (!sheetDrag.active) {
      // Unterhalb der Schwelle bleibt es ein Tipp -- die Geste ist aber schon
      // beansprucht, damit der Browser sie nicht doch als Scrollen startet.
      if (Math.abs(dy) < MIN_DRAG) return sheetDrag.owns;
      const body = $("asm-sheet-body");
      const canScroll = body.scrollHeight > body.clientHeight + 1;
      if (!sheetDrag.owns && sheetDrag.inBody && canScroll && !(dy > 0 && body.scrollTop <= 0)) {
        sheetDrag = null;                       // gehoert dem Scrollen
        return false;
      }
      sheetDrag.active = true;
      // Der Inhalt wird gleich sichtbar -- er soll oben anfangen.
      if (sheetDrag.owns) $("asm-sheet-body").scrollTop = 0;
      $("asm-sheet").classList.add("dragging");
    }
    // Die Karte folgt dem Finger, geklemmt zwischen Ruhe- und Vollhoehe.
    $("asm-sheet").style.height =
      `${Math.max(peekPx, Math.min(openPx(), sheetDrag.height - dy))}px`;
    return true;
  }

  function endSheetDrag() {
    if (!sheetDrag) return;
    const dragged = sheetDrag.active;
    sheetDrag = null;
    const sheet = $("asm-sheet");
    sheet.classList.remove("dragging");
    if (!dragged) return;                       // war ein Tipp -> Klick entscheidet
    // Naeher an offen oder an zu? Dorthin faellt die Karte zurueck.
    setSheetOpen(sheet.offsetHeight > (peekPx + openPx()) / 2);
  }

  // Maus laeuft ueber Zeiger-Ereignisse ...
  $("asm-sheet").addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") return;      // Finger: siehe touch-Handler
    startSheetDrag(e.clientY, e.target);
  });
  window.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    if (moveSheetDrag(e.clientY) && e.cancelable) e.preventDefault();
  }, { passive: false });
  window.addEventListener("pointerup", endSheetDrag);

  // ... der Finger dagegen ueber Touch-Ereignisse. Der Umweg ist noetig: sobald
  // der Browser eine Wischgeste als Scrollen erkennt, bricht er die
  // Zeiger-Ereignisse mit pointercancel ab -- der Zug blieb dann nach einem
  // Zucken stehen. Ein nicht-passives touchmove mit preventDefault nimmt ihm
  // die Geste ab, bevor er sie beansprucht.
  $("asm-sheet").addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    startSheetDrag(e.touches[0].clientY, e.target);
  }, { passive: true });
  $("asm-sheet").addEventListener("touchmove", (e) => {
    if (e.touches.length !== 1) return;
    if (moveSheetDrag(e.touches[0].clientY) && e.cancelable) e.preventDefault();
  }, { passive: false });
  $("asm-sheet").addEventListener("touchend", endSheetDrag);
  $("asm-sheet").addEventListener("touchcancel", endSheetDrag);

  // Tippen auf den Griff klappt um.
  $("asm-sheet-handle").addEventListener("click", () => setSheetOpen(!sheetOpen));

  // --- Bildschirm wachhalten (nur im Aufbau) -----------------------------
  // Beim Zusammenbauen liegt das Geraet daneben und wird lange nicht beruehrt.
  let wakeLock = null;
  async function updateWakeLock() {
    const gewuenscht = builder.mode === "assembly" && document.visibilityState === "visible";
    try {
      if (gewuenscht && !wakeLock && navigator.wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      } else if (!gewuenscht && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch {
      // Ohne sicheren Kontext oder bei abgelehnter Anforderung: kein Drama,
      // der Aufbau laeuft auch mit abschaltendem Bildschirm.
      wakeLock = null;
    }
  }
  document.addEventListener("visibilitychange", updateWakeLock);

  $("btn-color").addEventListener("click", (e) => {
    e.stopPropagation();
    openGroupPopup($("btn-color"), $("color-buttons"), "color-popup");
  });
  $("btn-view").addEventListener("click", (e) => {
    e.stopPropagation();
    openGroupPopup($("btn-view"), document.querySelector(".view-row"), "view-popup");
  });

  applyLayout();

  // Dev-Hook (nur mit ?dev): Layout-Zustand von aussen pruefbar machen.
  if (location.search.includes("dev")) {
    window.__layout = {
      measure: measureCollapse,
      overflows,
      get stage() { return collapseStage; },
      get tightAt() { return [...tightAt]; },
    };
  }

  Object.assign(ui, {
    update, start, touchActiveTab, openTab, closeTab, activateTab, captureActiveTab,
    openDocById, saveActiveTab, refreshDocList, isAutosaveOn, setAutosaveOn,
    syncButtons: syncDeleteButton,
  });
  // Als echte Zugriffsfunktionen anlegen: Object.assign würde einen Getter
  // sofort auswerten und den damaligen Stand einfrieren.
  Object.defineProperties(ui, {
    tabs: { get: () => tabs },
    activeTab: { get: () => activeTab() },
  });

  // Auto-Save-Schalter in den Einstellungen
  const autosaveBox = $("opt-autosave");
  if (autosaveBox) {
    autosaveBox.checked = autosaveOn;
    autosaveBox.addEventListener("change", () => setAutosaveOn(autosaveBox.checked));
  }

  refreshDocList();
  updateUndoButton();
  return ui;
}
