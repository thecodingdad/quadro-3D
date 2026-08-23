// Globale Konstanten fuer QUADRO 3D.

// Die 6 Achsen-Richtungen eines Wuerfel-Knotens (Three.js: y = oben).
export const DIRECTIONS = [
  { name: "+X", vec: [1, 0, 0] },
  { name: "-X", vec: [-1, 0, 0] },
  { name: "+Y", vec: [0, 1, 0] },
  { name: "-Y", vec: [0, -1, 0] },
  { name: "+Z", vec: [0, 0, 1] },
  { name: "-Z", vec: [0, 0, -1] },
];

// Schraege Rampen-/Dach-Richtungen. Projektvorgabe: alle Schraegen sind immer
// 45 Grad (eine waagerechte Achse kombiniert mit hoch/runter, normiert) -- auch
// wenn importierte QDF-Modelle andere Winkel angeben. 8 vertikale Diagonalen.
const S = Math.SQRT1_2; // 1/sqrt(2)  -> 45 Grad
export const DIAGONAL_DIRECTIONS = [
  { name: "+X+Y", vec: [S, S, 0] },
  { name: "+X-Y", vec: [S, -S, 0] },
  { name: "-X+Y", vec: [-S, S, 0] },
  { name: "-X-Y", vec: [-S, -S, 0] },
  { name: "+Z+Y", vec: [0, S, S] },
  { name: "+Z-Y", vec: [0, -S, S] },
  { name: "-Z+Y", vec: [0, S, -S] },
  { name: "-Z-Y", vec: [0, -S, -S] },
];

// Toleranz (cm), innerhalb der zwei Knoten als identisch gelten und verschmelzen.
export const MERGE_EPS = 0.5;

// Cosinus-Schwelle, ab der zwei Richtungsvektoren als "praktisch identisch"
// gelten (~8°). Genutzt fuer Belegungs-/Ausrichtungspruefungen entlang
// kardinaler/diagonaler Richtungen (builder.js).
export const DIR_ALIGN_TOL = 0.99;

// Lockerere Cosinus-Schwelle (~23°) fuer Arm-Richtungen rotierter Kupplungen
// (armDirs aus QDF-Import), die nicht exakt kardinal/diagonal ausgerichtet sind.
export const ARM_ALIGN_TOL = 0.92;

// Toleranz (cm) beim Andocken an eine vorhandene Schräg-Kupplung
// (extendDiagonalSnap in model.js).
export const DIAGONAL_SNAP_TOL = 3;

// Masse der aufgesteckten 45-Grad-Winkelkupplung (C45): Laenge der kardinalen
// Huelse (Basiskupplung -> Adapterkoerper) und des 45-Grad-Arms
// (Adapterkoerper -> Rohranschluss).
export const C45_SLEEVE_LEN = 10.83;
export const C45_ARM_LEN = 3.61;

// Max. Abstand (cm), bis zu dem ein Knoten beim Setzen eines zweiten Rohrs im
// Doppelrohrverbinder noch mit seinem Nachbarn verlinkt wird (builder.js).
export const CLAMP_LINK_DIST = 7;

// Schluessel fuer den automatischen Zwischenspeicher.
export const AUTOSAVE_KEY = "quadro.autosave.v1";

// Aktuelles Speicherformat. Aeltere Staende werden beim Laden angehoben
// (model.js, loadJSON), neuere abgelehnt.
//   1 -> 2: Der Punkt einer Klemme lag zwischen ihren beiden Loechern; jetzt
//           liegt er im Loch des gehaltenen Rohrs, wie in den QDF-Dateien.
export const FORMAT_VERSION = 2;
