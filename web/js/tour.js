// Onboarding-Demo: ein gefuehrter Rundgang durch die Oberflaeche.
//
// Beim allerersten Start laeuft sie von selbst (Merker in localStorage), spaeter
// laesst sie sich in den Einstellungen erneut starten. Waehrend der Demo liegt
// die Oberflaeche unter einem grauen Schleier, das gerade erklaerte Areal bleibt
// frei; weitergeschaltet wird ueber die Karte, nicht durch Klicken in die App.
//
// Kein Three.js, kein Zugriff auf die Interna von `ui.js` -- was die Demo an
// der Oberflaeche bewegen muss (Menue auf, Panel zeigen, Modus setzen), laeuft
// ueber die kleine Schnittstelle `ui.tour` (siehe ui.js).

import { t } from "./i18n.js";
import { APP_VERSION } from "./config.js";
import { BuildModel } from "./model.js";
import { getTube, spacingFor, defaultPanel } from "./catalog.js";

// Merker "Demo gesehen". Wie alle Einstellungen ein eigener localStorage-
// Schluessel (eine settings.json gibt es nicht). Gespeichert wird die Fassung,
// unter der sie gesehen wurde -- so laesst sich spaeter entscheiden, ob eine
// stark veraenderte Oberflaeche sie noch einmal zeigen soll.
const TOUR_KEY = "quadro.tour.v1";

const LUFT = 6;    // Luft zwischen Areal und Lochrand (px)
const RAND = 8;    // Mindestabstand der Karte zum Fensterrand (px)
const LUECKE = 12; // Abstand zwischen Loch und Karte (px)

export function tourSeen() {
  try { return !!localStorage.getItem(TOUR_KEY); } catch { return false; }
}

function merkeGesehen() {
  try { localStorage.setItem(TOUR_KEY, APP_VERSION); } catch { /* privater Modus */ }
}

function $(id) { return document.getElementById(id); }

/** Steht der Knoten gerade wirklich im Bild? */
function sichtbar(el) {
  if (!el || el.hidden) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  // offsetParent faellt bei position:fixed weg -- dort reicht das Rechteck.
  if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
  return true;
}

/** Umschliessendes Rechteck aller sichtbaren Knoten (oder null). */
function huelle(els) {
  const rects = (els || []).filter(sichtbar).map((e) => e.getBoundingClientRect());
  if (!rects.length) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

// --- Demo-Modell ---------------------------------------------------------
// Ein kleines Podest: Grundquadrat 40 x 40 aus 35ern, vier Stuetzen aus 75ern,
// oben dasselbe Quadrat und eine Platte darauf. So haben Ankerpunkte,
// Stueckliste und Aufbau-Modus etwas zu zeigen. Gebaut wird ueber die
// Modell-API statt aus festem JSON -- damit wandert es mit dem Speicherformat
// mit (FORMAT_VERSION) und kann nicht veralten.

const FARBE_RAHMEN = "yellow";
const FARBE_STUETZE = "blue";
const FARBE_PLATTE = "green";

function demoModell() {
  const m = new BuildModel();
  const kurz = getTube("T35"), lang = getTube("T75");
  if (!kurz || !lang) return m.toJSON();
  const sKurz = spacingFor(kurz.length_cm), sLang = spacingFor(lang.length_cm);

  // Waagerechter Ring um ein Feld -- vier Rohre, der letzte Knoten faellt per
  // Auto-Merge wieder mit dem ersten zusammen.
  const ring = (vonId) => {
    let id = vonId;
    for (const d of [[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1]]) {
      const r = m.extend(id, d, kurz.id, FARBE_RAHMEN, kurz.length_cm, sKurz);
      if (r && r.node) id = r.node.id;
    }
  };

  const start = m.addNode(0, 0, 0);
  ring(start.id);
  // Erst alle Ecken einsammeln, dann hochbauen: waehrend des Bauens kommen
  // neue Knoten dazu, ueber die nicht noch einmal gelaufen werden soll.
  const unten = [...m.nodes.values()].map((n) => n.id);
  for (const id of unten) m.extend(id, [0, 1, 0], lang.id, FARBE_STUETZE, lang.length_cm, sLang);
  const oben = m.findNodeNear(0, sLang, 0);
  if (oben) ring(oben.id);

  // Platte auf das obere Quadrat. Welches Rohrpaar sie traegt, sucht die
  // Modell-Logik selbst (panelPartners/panelSection) -- dieselbe wie im Editor.
  const platteId = defaultPanel();
  for (const rohr of [...m.tubes.values()]) {
    const a = m.nodes.get(rohr.a);
    if (!a || Math.abs(a.y - sLang) > 0.5) continue;      // nur die obere Ebene
    const partner = m.panelPartners(rohr.id, [40, 40])[0];
    if (!partner) continue;
    const abschnitt = m.panelSection(partner, partner.lo);
    if (m.addPanel(rohr.id, partner.id, abschnitt.t0, abschnitt.len, platteId, FARBE_PLATTE)) break;
  }
  return m.toJSON();
}

// --- Schritte -------------------------------------------------------------
// Ziele sind FUNKTIONEN, keine festen Selektoren: die Werkzeugleiste haengt
// ihre Knoepfe je nach Fensterbreite um (applyHeadCollapse/applyLayout in
// ui.js). Genannt wird deshalb jede Stelle, an der ein Knopf stehen kann; die
// Huelle nimmt, was gerade sichtbar ist. Ist nichts davon zu sehen, faellt der
// Schritt aus.

const STEPS = [
  {
    key: "welcome",
    before: (ctx) => ctx.ui.tour.openDemo(demoModell(), t("tour_demo_name")),
  },
  {
    key: "file",
    targets: () => [$("file-actions"), $("menu-file-rows")],
  },
  {
    key: "modes",
    targets: () => [$("mode-add").parentNode],
  },
  {
    // Zurueck und Wieder stehen IMMER in der Kopfzeile, das automatische
    // Speichern wandert bei engem Platz ins Menue -- deshalb ein eigener
    // Schritt: sonst entschiede das sichtbare Paar, dass das Menue zubleibt,
    // und der Schritt zeigte auf die falsche Stelle.
    key: "undo",
    targets: () => [$("btn-undo"), $("btn-redo")],
  },
  {
    key: "parts",
    before: (ctx) => ctx.ui.tour.setMode("add"),
    targets: () => [$("grp-build")],
  },
  {
    key: "color",
    targets: () => [$("color-buttons"), $("btn-color")],
  },
  {
    key: "canvas",
    before: (ctx) => ctx.ui.tour.setMode("add"),
    targets: () => [$("canvas-wrap")],
  },
  {
    // Raster und Tastenkuerzel stehen zusammen unten rechts. Der Szene-Schalter
    // gehoert NICHT dazu: er sitzt oben links, die Huelle waere sonst das halbe
    // Bild -- also ein eigener Schritt.
    key: "canvas_tools",
    targets: () => [$("btn-grid"), $("btn-help")],
  },
  {
    key: "scene",
    targets: () => [$("scene-toggle")],
  },
  {
    key: "view",
    targets: () => [document.querySelector("#toolbar-ctx .view-row"), $("view-mobile"), $("btn-view")],
  },
  {
    key: "tabs",
    targets: () => [$("tab-bar")],
  },
  {
    key: "sidebar",
    // Die Leiste kann zugeklappt sein -- der Schritt macht sie selbst auf und
    // faellt deshalb nie aus.
    immer: true,
    before: (ctx) => ctx.ui.tour.showPanel("bom"),
    // Auf schmalen Schirmen liegt die Leiste ueber der Szene und verdeckt den
    // naechsten Schritt -- dort geht sie wieder zu.
    after: (ctx) => {
      if (document.body.classList.contains("sidebar-overlay")) ctx.ui.tour.showPanel(null);
    },
    targets: () => [$("sidebar")],
  },
  {
    key: "assembly",
    targets: () => [$("mode-assembly")],
  },
  {
    key: "settings",
    before: (ctx) => ctx.ui.tour.openSettings(true),
    after: (ctx) => ctx.ui.tour.openSettings(false),
    // Das Popup haengt absolut unter dem Knopf -- das Rechteck des Knotens
    // darum herum enthaelt es NICHT, beide muessen einzeln genannt werden.
    targets: () => [$("btn-settings"), $("settings-pop")],
  },
];

// --- Ablauf ---------------------------------------------------------------

let lauf = null;       // { ctx, index, sichtbare, vorher } -- nur EINE Demo zugleich
let nachmessen = null; // Nachschlag, wenn das Ziel erst hereingleitet

/**
 * Menue-Schublade auf oder zu, je nachdem wo das Ziel steht. Bei enger
 * Kopfzeile wandern Datei-Eintraege, Modi und die Einstellungen in
 * `#toolbar-right-inner`; steht das Ziel dort und sonst nirgends sichtbar,
 * klappt die Demo das Menue auf.
 */
function menueFuer(ctx, ziele) {
  const schublade = $("toolbar-right-inner");
  const drin = ziele.some((e) => e && schublade.contains(e));
  const draussen = ziele.some((e) => e && !schublade.contains(e) && sichtbar(e));
  ctx.ui.tour.openMenu(drin && !draussen);
}

/** Loch auf das Areal setzen. Ohne Areal bleibt der Schleier ungelocht. */
function setzeLoch(rect) {
  const loch = $("tour-hole");
  if (!rect) { loch.classList.add("no-hole"); return; }
  loch.classList.remove("no-hole");
  loch.style.left = `${Math.round(rect.left - LUFT)}px`;
  loch.style.top = `${Math.round(rect.top - LUFT)}px`;
  loch.style.width = `${Math.round(rect.width + 2 * LUFT)}px`;
  loch.style.height = `${Math.round(rect.height + 2 * LUFT)}px`;
}

/**
 * Karte neben das Areal legen: darunter, sonst darueber, sonst daneben. Fuellt
 * das Areal fast den ganzen Schirm (Szene, Seitenleiste), bleibt nur, sie
 * hineinzulegen -- dann steht sie am unteren Rand des Areals.
 */
function setzeKarte(rect) {
  const karte = $("tour-card");
  karte.style.left = "0px";
  karte.style.top = "0px";
  const k = karte.getBoundingClientRect();
  const bw = window.innerWidth, bh = window.innerHeight;
  let left, top;
  if (!rect) {
    left = (bw - k.width) / 2;
    top = (bh - k.height) / 2;
  } else {
    const unten = rect.bottom + LUFT + LUECKE;
    const oben = rect.top - LUFT - LUECKE - k.height;
    const rechts = rect.right + LUFT + LUECKE;
    const links = rect.left - LUFT - LUECKE - k.width;
    if (unten + k.height <= bh - RAND) {
      top = unten; left = rect.left + rect.width / 2 - k.width / 2;
    } else if (oben >= RAND) {
      top = oben; left = rect.left + rect.width / 2 - k.width / 2;
    } else if (rechts + k.width <= bw - RAND) {
      left = rechts; top = rect.top + rect.height / 2 - k.height / 2;
    } else if (links >= RAND) {
      left = links; top = rect.top + rect.height / 2 - k.height / 2;
    } else {
      left = rect.left + rect.width / 2 - k.width / 2;
      top = rect.bottom - LUFT - LUECKE - k.height;
    }
  }
  karte.style.left = `${Math.round(Math.max(RAND, Math.min(bw - RAND - k.width, left)))}px`;
  karte.style.top = `${Math.round(Math.max(RAND, Math.min(bh - RAND - k.height, top)))}px`;
}

/** Loch und Karte an die aktuelle Lage des Ziels nachziehen. */
function messeNach() {
  if (!lauf) return;
  const schritt = STEPS[lauf.index];
  if (!schritt) return;
  const rect = schritt.targets ? huelle(schritt.targets()) : null;
  setzeLoch(rect);
  setzeKarte(rect);
}

/** Karte fuellen und Schritt anzeigen. */
function zeichne() {
  const schritt = STEPS[lauf.index];
  const nr = lauf.sichtbare.indexOf(lauf.index) + 1;
  $("tour-title").textContent = t(`tour_${schritt.key}_title`);
  $("tour-text").textContent = t(`tour_${schritt.key}_text`);
  $("tour-step").textContent = t("tour_step", nr, lauf.sichtbare.length);
  $("tour-back").hidden = nr <= 1;
  $("tour-next").textContent = nr >= lauf.sichtbare.length ? t("tour_done") : t("tour_next");
  messeNach();
}

/**
 * Welche Schritte lassen sich ueberhaupt zeigen? Ein Schritt ohne Ziel (die
 * Begruessung) zaehlt immer, einer mit Zielen nur, wenn wenigstens eines davon
 * im Bild steht -- oder in der Menue-Schublade, die die Demo dafuer aufklappt.
 */
function zeigbar(index) {
  const schritt = STEPS[index];
  if (!schritt.targets || schritt.immer) return true;
  const ziele = schritt.targets();
  const schublade = $("toolbar-right-inner");
  return ziele.some((e) => e && (sichtbar(e) || schublade.contains(e)));
}

function gehe(index) {
  if (!lauf) return;
  const alt = STEPS[lauf.index];
  if (alt && alt.after) alt.after(lauf.ctx);
  lauf.index = index;
  const schritt = STEPS[index];
  menueFuer(lauf.ctx, schritt.targets ? schritt.targets() : []);
  if (schritt.before) schritt.before(lauf.ctx);
  zeichne();
  // Das Umschalten (Menue, Panel, Modus) veraendert das Layout -- danach noch
  // einmal messen, sonst steht das Loch auf der alten Stelle. Und ein zweites
  // Mal nach der Blende: die ueberlagernde Seitenleiste GLEITET herein, nach
  // einem Bild steht sie erst zur Haelfte im Fenster.
  requestAnimationFrame(messeNach);
  clearTimeout(nachmessen);
  nachmessen = setTimeout(messeNach, 320);
}

function weiter() {
  if (!lauf) return;
  const pos = lauf.sichtbare.indexOf(lauf.index);
  if (pos < 0 || pos + 1 >= lauf.sichtbare.length) { beende(); return; }
  gehe(lauf.sichtbare[pos + 1]);
}

function zurueck() {
  if (!lauf) return;
  const pos = lauf.sichtbare.indexOf(lauf.index);
  if (pos <= 0) return;
  gehe(lauf.sichtbare[pos - 1]);
}

/** Demo beenden: Zustand zurueckgeben, Demo-Tab schliessen, Merker setzen. */
function beende() {
  if (!lauf) return;
  const { ctx, vorher, abmelden } = lauf;
  const schritt = STEPS[lauf.index];
  lauf = null;
  clearTimeout(nachmessen);
  if (schritt && schritt.after) schritt.after(ctx);
  abmelden();
  $("tour").hidden = true;
  ctx.ui.tour.openSettings(false);
  ctx.ui.tour.openMenu(false);
  ctx.ui.tour.closeDemo();
  ctx.ui.tour.restore(vorher);
  merkeGesehen();
}

/** Texte neu setzen -- der Sprachwechsel ruft das waehrend der Demo. */
export function refreshTour() {
  if (lauf) zeichne();
}

export function tourRunning() { return !!lauf; }

// Die drei Knoepfe der Karte gehoeren der Demo -- sie verdrahtet sie selbst,
// beim ersten Start und nur einmal.
let knoepfeVerdrahtet = false;
function verdrahteKnoepfe() {
  if (knoepfeVerdrahtet) return;
  knoepfeVerdrahtet = true;
  $("tour-next").addEventListener("click", weiter);
  $("tour-back").addEventListener("click", zurueck);
  $("tour-skip").addEventListener("click", beende);
}

/**
 * Rundgang starten. `ctx` ist `{ ui, builder, model, scene }`; gebraucht wird
 * davon nur `ui.tour` -- der Rest steht fuer den Dev-Hook bereit.
 */
export function startTour(ctx) {
  if (lauf) return;
  const sichtbare = STEPS.map((_, i) => i).filter(zeigbar);
  if (!sichtbare.length) return;

  const taste = (e) => {
    if (!lauf) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === "Escape") beende();
    else if (e.key === "Enter" || e.key === " " || e.key === "ArrowRight") weiter();
    else if (e.key === "ArrowLeft") zurueck();
  };
  // Die Oberflaeche ist gesperrt: der Schleier faengt jede Zeigergeste ab, damit
  // darunter nichts gebaut, gedreht oder umgeschaltet wird.
  const schlucke = (e) => { e.preventDefault(); e.stopPropagation(); };
  const veil = $("tour-veil");
  const beobachter = new ResizeObserver(() => messeNach());

  const abmelden = () => {
    window.removeEventListener("keydown", taste, true);
    window.removeEventListener("resize", messeNach);
    window.removeEventListener("orientationchange", messeNach);
    for (const art of ["pointerdown", "click", "wheel", "touchmove", "contextmenu"]) {
      veil.removeEventListener(art, schlucke, true);
    }
    beobachter.disconnect();
  };

  lauf = { ctx, index: -1, sichtbare, vorher: ctx.ui.tour.state(), abmelden };

  window.addEventListener("keydown", taste, true);
  window.addEventListener("resize", messeNach);
  window.addEventListener("orientationchange", messeNach);
  for (const art of ["pointerdown", "click", "wheel", "touchmove", "contextmenu"]) {
    veil.addEventListener(art, schlucke, { capture: true, passive: false });
  }
  beobachter.observe(document.body);

  verdrahteKnoepfe();
  $("tour").hidden = false;
  gehe(sichtbare[0]);
  // Der erste Schritt oeffnet das Beispielmodell -- damit steht auch die
  // Tab-Leiste da, die bei EINEM Tab im Hochformat ausgeblendet ist. Deshalb
  // die Liste der zeigbaren Schritte danach noch einmal bilden, sonst fehlte
  // der Schritt zu den Tabs genau dort.
  requestAnimationFrame(() => {
    if (!lauf) return;
    lauf.sichtbare = STEPS.map((_, i) => i).filter(zeigbar);
    if (!lauf.sichtbare.includes(lauf.index)) lauf.sichtbare.unshift(lauf.index);
    zeichne();
  });

  // Dev-Hook (nur mit ?dev): Schritte von aussen durchschalten und pruefen.
  if (location.search.includes("dev")) {
    window.__tour = {
      get step() { return lauf ? STEPS[lauf.index].key : null; },
      get index() { return lauf ? lauf.sichtbare.indexOf(lauf.index) : -1; },
      get count() { return lauf ? lauf.sichtbare.length : 0; },
      get steps() { return sichtbare.map((i) => STEPS[i].key); },
      rects() {
        if (!lauf) return null;
        const schritt = STEPS[lauf.index];
        return {
          ziel: schritt.targets ? huelle(schritt.targets()) : null,
          loch: $("tour-hole").classList.contains("no-hole")
            ? null : $("tour-hole").getBoundingClientRect(),
          karte: $("tour-card").getBoundingClientRect(),
        };
      },
      next: weiter, back: zurueck, end: beende,
    };
  }
}
