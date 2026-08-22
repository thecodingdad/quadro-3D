# The QDF file format

`.qdf` is the native format of **QUADRO 3D**, the Windows planning software (the binary at hand is `Quadro.exe`, build date 2006). No
specification was ever published. What follows is reconstructed — it is good
enough to read and write files that the original software accepts, but it is
not authoritative, and some fields are still a mystery.

Corrections are welcome. If you own files that use elements listed here as
"never seen", they would be very useful.

---

## 1. Where this knowledge comes from

Three sources, in descending order of reliability:

1. **Behaviour of the original software.** Files written by
   [`qdfexport.js`](web/js/qdfexport.js) load in QUADRO 3D and show the model
   as intended. Everything needed to achieve that is proven by construction —
   including a few things that are easy to get wrong, such as the quaternion
   scale (§3.2): with the wrong factor the software draws a completely
   scrambled model instead of refusing the file.
2. **A corpus of 239 files** — the example models shipped with the software
   plus files saved by it and by this app. Statements like "always" or "only
   two values occur" below refer to that corpus.
3. **The binary itself.** `Quadro.exe` contains a table of all element
   keywords (§4). It tells us which elements *exist*, not what their fields
   mean.

### Confidence levels

Every field table below marks each field:

| Mark | Meaning |
|---|---|
| **✔** | **Confirmed** — proven by the software accepting our files, or without a single exception in the corpus. |
| **~** | **Assumed** — consistent with everything we have seen and it explains the data, but not proven. |
| **?** | **Unknown** — the field is there, its meaning is open. |

---

## 2. File layout

A QDF file is plain text, CRLF line endings, one statement per line:

```
0, 0;
material3{1,"black", 1, 1.,1.,1., 0.,0.,1.,7.5, 0.,0.,0.,7.5, "", 0}
connector3{1, {4., 0., 0., 0., 0., 0., 0.}, 1, 0, 0, 63, 4095, 0}
tube2{2, {4., 0., 0., 0., 0., 0., 0.}, 1, 350., 0., 0}
```

- **Header line** — two identical numbers followed by `;`. 235 of the 239
  files carry `0, 0;`. The four exceptions carry the number of *editing
  steps* the file remembers (§3.5): a file with `1085, 1085;` has step
  numbers up to 1083 in it. **~**
- **Statement** — `name{ field, field, … }`. Fields are separated by `, `.
  One field may itself be a brace group — the placement tuple (§3.1).
- **Numbers** — whole values are written with a trailing dot (`350.`),
  fractions in full (`-2200.000000000004`). Integers used as flags or masks
  have no dot (`1`, `4095`).
- **Strings** — double quoted, only in `material3`.
- **Units** — millimetres, y is up, right-handed. The build grid is 400 mm
  (a 35 cm tube plus a 5 cm connector).
- **Order** — materials first, then parts. Within the parts the software
  writes connectors before tubes, but nothing depends on the order: our
  importer reads the file in several passes and the original software accepts
  our output, which uses a different order again.
- Anything the reader does not recognise is skipped. Unknown element names,
  extra fields at the end of a line and `camera2` lines all pass through
  harmlessly.

---

## 3. Building blocks

### 3.1 The placement tuple

Nearly every element carries one brace group of seven numbers:

```
{q0, q1, q2, q3, x, y, z}
```

`q0..q3` is an encoded quaternion (§3.2), `x, y, z` is the anchor point in
millimetres. **✔**

What the anchor point *is* differs per element and is the single most
error-prone part of the format: a tube stores its **starting end**, a panel
its **centre**, an integral slide the **foot of its run-out**, a ball pool the
**top edge of its front wall**. The element sections say which.

The rotation turns the element's local axes into world axes. Local **+X** is
the reference direction almost everywhere: the axis of a tube, the direction a
wheel spins around, the long edge of a panel.

### 3.2 Quaternion encoding

The four stored numbers are **not** the quaternion components. Each component
is squared, keeps its sign, and the result is scaled by 4:

```js
// file -> quaternion
const decode = (v) => Math.sign(v) * Math.sqrt(Math.abs(v));
// quaternion (unit) -> file
const encode = (c) => Math.sign(c) * c * c * 4;
```

The scale is why the absolute values of the four numbers always add up to
exactly 4 (a unit quaternion would give 1) — in all 10 958 tuples checked, no
exception. Writing them with scale 1 produces a file that loads but shows a
completely twisted model, which is how the factor was found. **✔**

Component order is `w, x, y, z` — note that three.js uses `x, y, z, w`.

Common values: `{4., 0., 0., 0.}` is the identity, `{2., 0., 2., 0.}` is 90°
about Y, `{1.707106781187, …}` and `{0.292893218813, …}` appear in 22.5°
constructions (they are `1 ± √2/2`).

### 3.3 Materials and colours

The `material3` lines at the top of the file define numbered materials; every
part references one by number in its first field. The corpus uses two sets of
the same colours: numbers 1–5 for tubes and connectors, 6–9 and 12/14 for
panels and fabric, 11 and 13 for the aluminium profile. Colour is taken from
the **name** in the material line, not from the RGB triple. **✔**

### 3.4 Part size vs. grid span

Lengths in the file are the **part** size, not the distance between connector
centres. A tube that spans one 400 mm grid field is stored as `350.` — the
connector contributes the missing 50 mm. Same for panels: a 40 × 40 cm panel
is `350.` × `350.`. **✔**

Sizes come in **pairs**: a base size followed by a second number that is
almost always `0.`. Where it is not zero, it is an **addition to the base
size** — the total is the sum. This matters in rotated or 22.5° constructions,
where parts do not sit on whole grid steps: of the 729 `tube2` lines with a
non-zero second number, the far end lands on a connector in 665 cases when the
two are added, and in 3 cases when the second number is ignored. For panels
the same test gives all four corners on connectors for 74 of 96 panels with
the addition, and 25 without. **✔**

### 3.5 Editing-step fields at the end of a line

Some lines carry one or two extra integers after their regular fields:

```
tube2{2, {4., 0., 0., 0., 0., 0., 0.}, 1, 350., 0., 1, 27}
                                              ^^^^^^  extra
```

They look like a **step range**: the numbers are small, they run from 1 up to
the number in the header line, and they come in pairs like `(0,1)`, `(1,2)`,
`(27,27)`. The reading that fits everything we see: the file keeps a history,
and a line with a range describes a part that existed only between those two
editing steps. Lines with a range are frequently exact duplicates of lines
without one. **~**

Practical consequence, and the reason this matters: **a reader should ignore
lines that carry these fields.** The reference viewer does, this app does
(`hasRenderRange` in [`qdfimport.js`](web/js/qdfimport.js)), and it is what
makes an imported model match the picture the original software draws. Without
the filter, models come out with duplicated and mirrored parts.

### 3.6 The field every element has

Field 2 — right after the placement tuple — is `0` or `1` in every element
type. `1` dominates (about 92 % of all lines). We write `1` everywhere and the
software is happy with that, which rules out any meaning that would have to
vary. Best guess: a visible/active flag. **~**

---

## 4. The element catalogue

`Quadro.exe` contains a table of all 44 element keywords at offset `0x1c2650`.
Sorted by how often they appear in the corpus:

| Element | Lines in corpus | What it is |
|---|---:|---|
| `tube2` | 21 275 | straight tube |
| `connector3` | 15 429 | connector cube |
| `material3` | 3 365 | material definition |
| `panel2` | 2 935 | panel |
| `camera2` | 953 | saved view |
| `connector45_2` | 736 | 45° angle connector |
| `round-tube2` | 311 | quarter-circle bow tube |
| `alu2` | 174 | aluminium reinforcement profile |
| `steering-lock2` | 172 | steering lock |
| `flexi-connector3` | 168 | flexi connector arm |
| `bearing2` | 125 | bearing (wheel axle) |
| `multi-wheel2` | 125 | spoked wheel |
| `bearing-connector4` | 101 | bearing connector clamped on a tube |
| `bolt2` | 84 | bolt holding a flexi joint |
| `textil2` | 82 | net / fabric sheet |
| `slide-end2` | 82 | slide run-out |
| `slide2` | 77 | modular slide body |
| `floating-wheel2` | 76 | floating wheel |
| `open-connector2` | 69 | open connector |
| `hub-cap2` | 58 | hub cap |
| `textil-round2` | 54 | curved fabric wall |
| `hole-connector4` | 51 | hole-pin connector |
| `roof2` | 42 | roof sheet |
| `pool2` | 42 | ball pool |
| `casters2` | 36 | caster |
| `lattice2` | 18 | lattice / net panel |
| `curved-slide2` | 10 | curved slide body |
| `roof-large2` | 9 | large roof |
| `tube-cap2` | 9 | tube cap |
| `slide-new2` | 7 | integral slide |
| `adapter2` | 7 | adapter |
| `bag2` | 6 | play bag |
| `clamp2` | 3 | double-tube connector |
| `clip2` | 1 | tube clip |
| `pool-small2` | 1 | small ball pool |
| `alu-connector2` | 0 | short aluminium profile |
| `display2` | 0 | info sign (same shape as `panel2`) |
| `wood2` | 0 | wood part |
| `wood-bed2` | 0 | wood bed |
| `wood-knob2` | 0 | wood knob |
| `round-wood2` | 0 | round wood part |
| `chairseatback2` | 0 | chair seat back |

The nine with zero lines exist in the binary only. `alu-connector2` and
`display2` are handled by this app's importer anyway (a 400 mm profile and a
panel respectively); the wood parts and the chair back are from product lines
we have never seen a file for.

---

## 5. Elements in detail

Every table lists the fields **after** the element name, counted from 0. Field
1 is the placement tuple (§3.1) throughout, and field 2 is the flag from §3.6;
both are only repeated in the tables for completeness.

### 5.1 Structure

#### `connector3` — connector cube

```
connector3{1, {4., 0., 0., 0., 0., 0., 0.}, 1, 0, 0, 63, 4095, 0}
```

| # | Meaning | Level |
|---|---|---|
| 0 | material number (always 1 = black) | ✔ |
| 1 | placement, anchor = centre of the cube | ✔ |
| 2 | active flag (§3.6) | ~ |
| 3 | almost always 0; a handful of lines carry 63, 60, 15 or 51 | ? |
| 4 | **arm mask**: which of the six sockets exist, in the cube's *local* axes — `0x01` +X, `0x02` −X, `0x04` +Y, `0x08` −Y, `0x10` +Z, `0x20` −Z | ✔ |
| 5 | complement of field 4: `63 − mask`, without exception in the corpus | ✔ |
| 6 | face visibility mask, `4095` = `0xFFF` in more than half the lines, 226 different values overall | ~ |
| 7, 8 | editing-step range, only on some lines (§3.5) | ~ |

The arm mask is what makes a connector look like the real part: it includes
sockets with no tube in them. Because the mask is local, a rotated connector
has to have its world directions rotated back before the bits are read.

#### `connector45_2` — 45° angle connector

```
connector45_2{1, {4., 0., 0., 0., 0., 800., -1000.}, 1, 0, 27, 36, 4095, 0}
```

| # | Meaning | Level |
|---|---|---|
| 0 | material number | ✔ |
| 1 | placement, anchor = the connector it sits on | ✔ |
| 2 | active flag | ~ |
| 3 | 0 in almost every line, 1 in 40 | ? |
| 4 | 0 in every line but four | ? |
| 5 | only present on those four lines | ? |

Two things are important here, both confirmed by what the software accepts:
the angle connector does **not** replace the connector it sits on — the file
carries a `connector3` at the same point as well — and the line has **five
fields**, not the eight of a `connector3`. Writing eight makes the software
reject the file.

The tube leaving an angle connector starts about 86.7 mm off the connector
centre, which is the length of the adapter arm.

#### `tube2` — straight tube

```
tube2{2, {4., 0., 0., 0., 0., 0., 0.}, 1, 350., 0., 0}
```

| # | Meaning | Level |
|---|---|---|
| 0 | material number (colour) | ✔ |
| 1 | placement, anchor = **starting end**, local +X = tube axis | ✔ |
| 2 | active flag | ~ |
| 3 | tube length in mm — the part, not the grid span (§3.4). Seven catalogue lengths occur: 100, 150, 200, 250, 350, 520 and 750 | ✔ |
| 4 | addition to the length (§3.4), `0.` in 93 % of lines | ✔ |
| 5 | 0 on ordinary lines | ? |
| 6 | editing-step range on some lines (§3.5) | ~ |

The far end is `start + direction × (length + addition + 50 mm)`.

Files written by this app can carry a measured length instead of a catalogue
one (four lines of `774.2037` in our own corpus) — the original software takes
those without complaint.

#### `round-tube2` — bow tube

```
round-tube2{2, {0., 2., 0., 2., 1600., 800., -400.}, 1, 350., 0., 0}
```

Same fields as `tube2`, and the length is `350.` in every single line — the bow
comes in one size only. **✔**

The geometry is a quarter circle: local **+X** is the tangent at the starting
end, local **+Y** points at the centre of the circle, and the radius is the
grid step (length + 50 mm). Centre `C = start + Y·R`, far end
`E = start + R·(X + Y)`. This was worked out by fitting both ends onto
existing connectors — read as a straight tube, a bow lands nowhere near the
frame. **✔**

#### `alu2`, `alu-connector2` — reinforcement profile

```
alu2{11, {4., 0., 0., 0., -400., 800., 0.}, 1, 800., 0., 0}
```

Fields as `tube2`. Two lengths occur, `800.` and `600.`, and the profile
usually bridges a **joint**: it sits centred over the connector between two
collinear reinforced tubes rather than inside a single tube. The material
number is 11 in 166 of 174 lines. **✔**

`alu-connector2` is in the binary's table (a 400 mm profile) but appears in no
file we have.

### 5.2 Surfaces

#### `panel2`, `display2` — panel and info sign

```
panel2{8, {0., 0., 2., 2., -200., 400., -200.}, 1, 350., 0., 350., 0., 0}
```

| # | Meaning | Level |
|---|---|---|
| 0 | material number (panel colour set) | ✔ |
| 1 | placement, anchor = **centre** of the panel, in the plane of the tube axes | ✔ |
| 2 | active flag | ~ |
| 3 | first edge, part size in mm — belongs to the local **Y** axis | ✔ |
| 4 | addition to field 3 (§3.4) | ✔ |
| 5 | second edge, belongs to the local **X** axis | ✔ |
| 6 | addition to field 5 | ✔ |
| 7 | 0 on ordinary lines | ? |
| 8 | editing-step range on some lines (§3.5) | ~ |

Which edge belongs to which axis matters: swap them and a 40 × 20 panel comes
out across the frame. The corpus is unanimous — first size on Y — in all 98
non-square panels. **✔**

The local **Z** axis says which side of the tubes the panel is fastened to.
Panels with holes are not distinguishable in the file; they carry the same
sizes as the solid ones.

`display2` has the same shape and is read as a panel.

#### `textil2` — net / fabric sheet

```
textil2{7, {2., 0., 0., 2., -200., 400., -1000.}, 1, 350., 0., 750., 0., 0}
```

Fields as `panel2`. The second size is `750.` in every line of the corpus. The
sizes are part sizes again: `350. × 750.` spans a 40 × 80 cm field. **✔**

#### `lattice2` — lattice panel

```
lattice2{8, {2., 0., 0., 2., 2000., 812.5, 0.}, 1, 1550., 0., 775., 0., 0}
```

Fields as `panel2`, but the sizes are the **true** span of the sheet, not the
part size: `1550 × 775` measures exactly from −775 to +775 around the anchor.
**✔** Unlike `panel2`, both orders occur (`1550, 775` twice as often as
`775, 1550`), so a reader has to try both.  **✔**

### 5.3 Clamps, adapters, special connectors

#### `hole-connector4` — hole-pin connector

```
hole-connector4{1, {2., -2., 0., 0., 1249.999999999932, 1500.000021502626, -899.999978497104}, 0, 0, 11, 8, 3840, 0, 0}
```

| # | Meaning | Level |
|---|---|---|
| 0 | material number | ✔ |
| 1 | placement, anchor = **mouth of the open socket**; the tube in it runs along local **−Y** | ✔ |
| 2 | active flag, `0` in most lines here | ~ |
| 3 | 0 (one line has 60) | ? |
| 4 | arm mask, `11` in 50 of 51 lines; a value of 11 means the three-armed variant, a single bit the one-armed | ~ |
| 5 | field 4 minus 3, without exception | ✔ |
| 6 | `3840` = `0xF00` in every line | ? |
| 7, 8 | 0 on most lines | ? |

The part grips **over a socket of a connector** — it does not clamp a tube
directly, and it does not replace the connector next to it. The −Y reading of
the tube direction holds in all 26 cases where a tube is attached. **✔**

#### `clamp2`, `clip2` — double-tube connector and tube clip

```
clamp2{2, {2., 0., 0., 2., -1200., 510., 50.}, 1, 0}
clip2{2, {2., 0., 0., 2., 0., 260., 0.}, 1, 0, 3}
```

| # | Meaning | Level |
|---|---|---|
| 0 | material number (both are red parts) | ✔ |
| 1 | placement, anchor = a point on the tube, local +X = tube direction | ✔ |
| 2 | active flag | ~ |
| 3 | 0, except two `clamp2` lines carrying step numbers | ? |
| 4 | `clip2` only: **must be `0` for the part to be drawn** | ✔ |

Field 4 of `clip2` was worth chasing: with the `3` of the single corpus line
the software loads the file and draws nothing at all, with `0` the clip appears
(208 triangles, 50 × 95 × 57 mm). Field counts matter as well — four or seven
fields make the software reject the **whole file**, five and six are accepted.
That is how the mesh in `tmp/extracted/models/clip2.obj` was obtained. **✔**

The double-tube connector is a figure eight holding **two parallel tubes**
about 50 mm apart; the file stores only one point, and the second tube has to
be found geometrically.

#### `bearing2` — bearing

```
bearing2{1, {4., 0., 0., 0., 0., 1200., 200.}, 1, 50., 0., 0}
```

Field 3 is `50.` in every line, field 4 `0.`, field 5 `0`. It sits at the same
point as the connector that carries it — the file has both lines. **✔**

#### `bearing-connector4` — bearing connector

```
bearing-connector4{1, {…}, 1, 0, 34, 0}
```

| # | Meaning | Level |
|---|---|---|
| 3 | 0, or 51 in 15 lines | ? |
| 4 | 0, 34, 32, 35, 1 or 3 — looks like a mask | ? |
| 5 | 0 in every line | ? |

This app reads the part, names it and writes the original fields back
untouched.

#### `flexi-connector3`, `bolt2` — flexi joint

```
flexi-connector3{1, {…}, 1, 60, 0, 8, 0, 17, 0}
bolt2{1, {0., 0., 4., 0., 2000., 1200., 0.}, 1, 150., 1, 0}
```

A flexi joint is **two arms and a bolt**, and there is deliberately no
`connector3` at that point. `flexi-connector3` field 5 is `8` in every line,
field 7 takes eight values (17, 32, 18, 33, 16, 35, …) and probably encodes
the arm direction **~**; fields 3, 4, 6 and 8 are open **?**.

`bolt2` field 3 is `150.` in every line (the bolt length), field 4 is 0 or 1.
**✔** / **?**

#### `open-connector2`, `adapter2`, `tube-cap2`

Four fields each: material, placement, flag, `0`. They are single small parts
sitting on a socket. **✔**

The three are easy to mix up, so here is what the software actually draws
(measured from the meshes captured out of `Quadro.exe`, axis = local +X,
origin = the connector centre the part sits on):

| Element | Length | Along +X | Ends |
|---|---:|---|---|
| `open-connector2` | 50 mm | +25 … +75 | **both open**, inner radius 17 mm |
| `adapter2` | 55 mm | +25 … +80 | one closed |
| `tube-cap2` | 24 mm | −45 … −21 | one closed |

So the tube cap is `tube-cap2`, and `open-connector2` is a through sleeve one
connector length beside the cube. **✔**

### 5.4 Wheels

`multi-wheel2`, `floating-wheel2`, `hub-cap2`, `casters2` and
`steering-lock2` all have the same four fields: material, placement, flag,
`0`. The wheel spins about the local **+X** axis. **✔**

### 5.5 Slides and roofs

```
slide2{6, {2., 0., 2., 0., 0., 800., -2200.000000000004}, 1, 0}
slide-end2{9, {2., 0., 2., 0., 1200., 0., -2200.000000000004}, 1, 0}
slide-new2{6, {2., 0., 2., 0., 400., 0., 1000.}, 1, 0}
curved-slide2{7, {2., 0., -2., 0., -1200., 1450., -200.}, 1, 0}
roof2{4, {…}, 1, 0}
roof-large2{0, {…}, 0, 0}
```

Four fields each — **no dimensions at all**. Slides are fixed parts, and the
shapes are hard-coded in the software; a reader has to know them. **✔**

The anchor point differs between the chain parts and the integral slide, and
this trips people up:

- `slide2` and `curved-slide2` are **chain** parts: the anchor is the **entry**
  (top) end, and the next part of the chain sits at the local offset
  `(0, −800, 1200)` for the straight body and `(600, −800, 600)` for the curved
  one — 73 of 76 occurrences. **✔**
- `slide-end2` closes a chain; its anchor is its own upper connection. **✔**
- `slide-new2` is the one-piece integral slide, and its anchor is the **foot**
  of the run-out. The entry is 850 mm up and 1200 mm back along its run
  direction. **✔**
- In the manufacturer's files a 350 mm tube sits under an integral slide, its
  centre exactly on the slide's anchor. It is part of the slide, not a tube of
  the frame. **✔**

`roof2` and `roof-large2` are fabric roofs with the same four fields;
`roof-large2` is the only element that regularly carries material `0`.

### 5.6 Play equipment

#### `pool2`, `pool-small2` — ball pool

```
pool2{8, {4., 0., 0., 0., -200., 400., 800.}, 1, 0}
```

Four fields, no dimensions. The pool is **one** element in the file even
though it looks like five panels. The anchor is the **top edge of the front
wall**, and the wall size is fixed per variant: 1200 × 400 mm for `pool2`,
400 × 200 mm for `pool-small2`. **✔**

The **depth is not in the file at all** — it has to be derived from the frame
(this app walks the connectors behind the front wall). **✔**

#### `bag2` — play bag

Four fields. The anchor sits on **one** of the two tubes the bag hangs
between; the centre of the field is 200 mm further along the local +Z axis (at
all five occurrences in the corpus). **~**

#### `textil-round2` — curved wall

Five fields: material, placement, flag, then a number that is `0` in 31 lines
and `1` in 23 — probably which way the quarter cylinder curves **~** — and a
final `0`. **?**

### 5.7 Document elements

#### `material3`

```
material3{1,"black", 1, 1.,1.,1., 0.,0.,1.,7.5, 0.,0.,0.,7.5, "", 0}
```

| # | Meaning | Level |
|---|---|---|
| 0 | material number, referenced by every part | ✔ |
| 1 | name — `black`, `red`, `green`, `blue`, `yellow`, `alu`, `white`, `mirror`; this is what a reader should key colours off | ✔ |
| 2 | set: 1 for tubes and connectors, 2 for panels and fabric | ~ |
| 3–5 | RGB, 0…1 | ✔ |
| 6–9 | four numbers, the last always `7.5` — a specular/gloss group | ~ |
| 10–13 | same shape again, second lighting group | ~ |
| 14 | empty string in every line — probably a texture name | ~ |
| 15 | 0 in every line | ? |

#### `camera2` — saved view

25 numeric fields. Field 17 is `3000` in every line, fields 18 and 19 are `10`
in almost all, fields 3–7 and 11 are always 0. The rest varies with the view.
Nothing else is known, and this app neither reads nor writes the line. **?**

---

## 6. What we do not know

Collected list of open points, if anyone wants to dig:

- `connector3` field 3 (a handful of non-zero values) and the 226 different
  values of the face mask in field 6.
- The trailing `0` before the step range on `tube2`, `panel2`, `textil2`.
- `connector45_2` fields 3–5.
- `hole-connector4` field 6 (`3840` everywhere), `bearing-connector4`
  fields 3–5, `flexi-connector3` fields 3, 4, 6 and 8, `textil-round2`
  field 3.
- The two numbers in the header line — the step-count reading fits the four
  files that have one, and that is thin evidence.
- Whether the step range means "created in step a, deleted in step b" or
  something else, and why so many of those lines are duplicates.
- All 25 fields of `camera2`.
- Everything about the nine element types that exist only in the binary.

---

## 7. How QUADRO 3D (this app) reads and writes QDF

[`qdfimport.js`](web/js/qdfimport.js) and [`qdfexport.js`](web/js/qdfexport.js)
are free of three.js and DOM, so they can be run and tested under Node.

**Reading.** Several passes: materials and connectors first (so tube ends have
something to snap to), then tubes, then panels, nets and pools, then the
aluminium profiles, then the double-tube connectors. Tube ends snap to the
nearest connector within 55 mm. Sizes are read as a pair and added up (§3.4);
the catalogue part is still chosen by the base size, since the addition is
extra distance, not extra tube. Lines carrying a step range are skipped
(§3.5). Elements we cannot draw are still read, named and counted — the ones
we cannot even name (`wood2` and friends) are ignored.

Because the file's own geometry is more reliable than anything recomputed, an
imported tube, bow or panel keeps its exact placement from the file (`geom` in
the model) and writes it back unchanged. That is also why ignoring the size
addition of §3.4 does no harm here: parts stay where the file put them until
they are moved.

**Writing.** Materials, then connectors, tubes, profiles, panels, nets,
clamps, fittings, slides. Three things are worth knowing:

- A 45° angle connector is written as a `connector3` **plus** a
  `connector45_2` at the same point, and the latter with five fields — with its
  **own** quaternion. The two are not the same: the cube is rotationally
  symmetric, the angle connector is not, and at 559 of 726 occurrences in the
  sample files the two lines at one point carry different quaternions.
- Reinforcements are written as **runs** bridging joints, not as one profile
  per tube — that is how the manufacturer's files have it.
- `camera2` is never written: what its 25 fields do is unknown, and the
  software falls back to its own default view.
- Size additions are written back where they came from, and the two sizes of
  an imported panel keep the order the file had them in.

**Perforated panels ride on a material.** The format has no perforated panel:
there is no element for it in the binary's keyword table, and `panel2` has no
spare field — field 3 is the visibility flag, fields 8 and 9 are the step range,
and the two size fields each carry their addition. So this app writes a
perforated panel as an ordinary `panel2` that points at a **material of its
own**: same colour values as the solid panel, but a separate number (15–19) and
a name ending in `" (hole)"`. The manufacturer's software draws a normal panel
in the same colour, so the file stays valid and looks right there; we recognise
the panel on the way back in. That extra materials are tolerated is not a
guess — 19 of the sample files carry a material 20 and six a material 21, with
free-form names up to `"new material"`, all written by the software itself.
Numbers 15 to 19 are unused across the whole corpus.

**What a round trip does not preserve.** Diagonals are normalised to 45°;
parts with no QDF equivalent are dropped; panel sizes are written from the
catalogue rather than measured, so a panel on a slope moves by up to a
centimetre; and the step-range history is not kept — a file saved here has no
history at all.

Round-trip fidelity, measured over the 239 files: 20 385 of 20 513 tubes come
back out with exactly the same anchor and length (99.4 %), and re-importing our
own output and exporting it again gives a byte-identical file for 231 of them —
the eight that differ do so in the last digits of a quaternion only.

What it *does* preserve is every part. Importing and re-exporting
`Universal II+Rutsche+Pool` gives the same line count for every element type —
112 tubes, 76 connectors, 4 angle connectors, 4 bows, 12 panels, 2 profiles,
the pool, the roof and both slide parts. Only two kinds of line differ: the
four `camera2` lines are gone, and the material table is written in full
(12 entries instead of the 16 that file happened to carry).
