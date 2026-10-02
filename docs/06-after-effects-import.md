# After Effects import

_Status 2026-10-02. After Effects isn't installed on the build PC; how each route was proven is described below._

## Two routes, one importer

| Route | Needs After Effects? | How | Fidelity |
|---|---|---|---|
| **Open the .aep directly** | **No** | `@be/aep` reads the binary RIFX project file in TypeScript (inside the app; no other software). | Everything the file stores. A few things AE computes at run time can't be read: RotoBezier curves, gradient colours, and default settings that third-party effects don't store. Each one is reported. |
| **Before Effects exporter script** | Yes (CC 2018 or later) | `tools/ae-exporter/BeforeEffectsExport.jsx`. In After Effects choose File › Scripts › Run Script File…. It writes `<project>.beforeeffects.json` next to the .aep. | After Effects resolves every value itself, including text, masks, keyframes, effects and media paths. |

Both routes produce the same data (`packages/core/src/ae-json.ts`): After Effects' own scripting object model, addressed by match name. One importer turns that data into a Before Effects show (`packages/core/src/ae-import.ts`).

In the app:
1. Choose **Welcome › An After Effects project**, and pick the `.aep` or the `.beforeeffects.json`.
2. Media is looked for where After Effects saved it, then next to the project, including a `(Footage)` folder.
3. Found media is copied into the show.
4. Anything still missing can be found later with **Find missing files…** (in the report and in Add content), which searches a folder and its subfolders by file name.
5. The original file is copied, unchanged, next to the show's media, and **the compatibility report** is saved beside it.
6. The report also opens on screen. It groups every difference as Missing, Not imported yet, Kept but not shown yet, or Approximated. Everything not listed came across as it was.

## What comes across

- **Exact:**
  - Compositions: size, frame rate (exact NTSC), duration, background, work area and markers.
  - Layers: order, names, timing (start, in, out), stretch, enabled, solo, lock, audio switch, parenting, track mattes and the 3D flag.
  - Transform keyframes: linear, Bezier and hold, temporal ease (speed and influence), spatial tangents, and roving.
  - Masks: mode, inverted, path keyframes, opacity and expansion.
  - Solids, footage and precomps.
  - Shape-layer paths, fills, strokes and trim paths. Rectangles and ellipses become Bezier paths.
  - Text content, font, size, colour, stroke and alignment.
  - Gaussian Blur and Glow, matched approximately in strength.
- **Kept, not rendered yet:**
  - Every other effect, with all of its settings.
  - Expressions.
  - Cameras and lights, with their animation.
- **Approximated:**
  - 3D layers, which render flat.
  - Separately animated position dimensions, which are combined.
  - Text layout.
  - Group transforms other than position.
  - Blend modes Before Effects lacks, which become Normal.
  - Non-square pixels and custom timeline start times.
- **Not imported yet:**
  - Text animators and text on a path.
  - Time remapping, motion blur, layer markers, layer styles.
  - Shape operators such as Repeater and Merge Paths.

## Proof (2026-10-02)

- **Binary reader, against After Effects' own exports:**
  - The corpus is the py_aep test set: 603 projects saved by real After Effects 2018–2026, 498 of them with an After Effects JSON export.
  - **603/603 read without error.**
  - 100% on every item, composition, footage, layer and marker field, on property trees, transform values and all 321 keyframes. 17,658/17,660 effect values match; the 2 misses are from a third-party plug-in.
  - Mask paths, shape paths and 168 text documents were checked against py_aep, which is itself verified against After Effects: all match.
  - Commands: `packages/aep/test/compare.ts` (corpus) and `packages/aep/test/aep.test.ts` (113 tests on 46 fixtures).
- **Importer, on real After Effects exports:** the "complete" projects from AE 2018, 2022, 2023, 2024, 2025 and 2026 each have 6 compositions, 24 footage items, 33 layers (including precomps, text, shapes, cameras, lights, masks, effects, expressions, track mattes, guide and adjustment layers) and 14 keyframes. Every composition evaluates at any time.
- **End to end without After Effects:** `packages/aep/test/import.test.ts` takes 46 `.aep` files through the reader and importer into a show that evaluates (47 tests). The 2026 project's text ("Styled Text" in Arial), masks and shapes come straight from the binary. Reading takes about 10 ms and importing about 1 ms.
- **Exporter script:** `tools/ae-exporter/test/exporter.test.ts` runs the real `.jsx` against a simulated After Effects scripting model built from a real export of the AE 2026 project. Its output reproduces every item, layer and all 5,181 property-tree entries, keyframes included, and imports with text, masks and media paths restored. *This proves the script's logic, not its behaviour inside After Effects*, which can't be run on this PC. That remains to be checked by someone with After Effects.
- **In the app** (journey steps `ae-*`):
  - Opening `complete.aep` shows the report (6 compositions, 33 layers) and opens Main_Comp.
  - The report file and the copy of the original exist.
  - The preview draws.
  - Opening the exporter JSON relinks `mov_480.mov`, found next to the export, and restores the text "Hello projection".

## Not yet

- `.aepx` (XML) projects. The app explains how to save as `.aep` or use the exporter instead.
- Rendering for effects other than Blur and Glow, plus expressions, 3D cameras and lights. They are kept in the show, so they'll light up as those features arrive.
- Round trip back to After Effects.
