# Blender: simulated effects and linked .blend files

_Status 2026-10-02._

Before Effects uses Blender for physical simulations it doesn't do itself, and to bring in a person's own Blender scenes. Blender is optional and installed separately (GPL; personal use). Everything else in the app works without it.

## What the person does

**An effect on areas.** Select one or more areas. The inspector's **Simulated in Blender** section (badge: *physical*) offers:

| Effect | What happens | Simulated by |
|---|---|---|
| **Smoke** | Billowing smoke rises from the area and flows around the house. | Blender Mantaflow (gas) |
| **Fire** | Flames lick up from the area, with a little smoke. | Blender Mantaflow (fire + smoke) |
| **Water pouring** | Water bursts out of the area, splashes down the front of the house and runs off. | Blender Mantaflow (liquid, FLIP) |
| **Cloth reveal** | A sheet hangs over the area, lets go and crumples at the foot of the house. | Blender cloth |
| **Break apart** | The area breaks into photo-faced pieces that fall, tumble and land on the house and the ground. | Blender rigid bodies (Bullet) |

The built-in **Collapse & rebuild, Explode and Crumble (3D)** use Before Effects' own Rapier physics and stay available alongside. They adjust live; Blender's version comes back as a video.

Then:
- Progress shows while Blender works ("Building the Blender scene", "Simulating in Blender 40 of 120", "Rendering in Blender", "Making the video"). **Cancel** stops Blender and adds nothing.
- When Blender finishes, the result is an ordinary video layer with transparency, on top of the scene, lined up exactly with the canvas. A draft takes about 20–90 s.

The effects library also contains procedural look-alikes (Smoke rising, Fill with flowing water, Crack & rebuild). Their cards carry a *procedural* badge, and their descriptions name the physical alternative.

**On a layer Blender made**, the **Made in Blender** section has **Settings**. These are every setting of the effect, plus its name, areas, start, length and quality, gathered and applied together with **Simulate again** (see [13-effects-and-settings.md](13-effects-and-settings.md) for what updates when). It also offers:
- **Open in Blender**: opens its .blend in Blender's own window.
- **Update from Blender**: renders the .blend again, keeping your edits, and swaps the video in the same layer. The button lights up and a note appears when the .blend changed since the last render.
- **Render at full quality**: full canvas size and finer simulation. For an effect this rebuilds the scene, which replaces edits made in Blender; the button says so.

Each result is one undo step: the layer, the media and the link together.

**Editable 3D from your .blend.** On a linked .blend's layer, **Bring in as editable 3D** has Blender export its meshes, materials, lights and animation (baked over the link's length) as a model. The model appears in a 3D layer, where you can move, scale, turn and retime it, change its animation speed and start, and light it, all inside Before Effects.

A report lists every object as one of:
- **Editable:** meshes, including modifiers applied, bones and shape keys; point, spot and sun lights; groups.
- **Approximated:** text and curves become meshes; non-standard shading becomes a standard material; a cloth or particle object comes across at rest.
- **In the video only:** smoke and liquid domains, volumes, particle and cloth motion.
- **Not carried:** cameras (the show camera is Before Effects', lined up with the building); area lights; Grease Pencil.

**Update the 3D from Blender** after editing swaps in the new model and keeps your placement, timing and lights. Smoke, fire, water and cloth that Before Effects made come back as video only, because volumes and simulations can't be carried as editable shapes.

**Your own .blend.** Use **Link your own .blend…**. The file is rendered with its own camera, frame range start and lights. It comes in as a layer that you can update after editing it in Blender.

**Finding Blender.** Before Effects looks in these places, in order:
1. the choice saved by **Choose blender.exe…**;
2. `<data folder>\Tools\blender*` (a portable Blender unpacked there works);
3. Program Files;
4. Steam;
5. PATH.

## How it works

`packages/core/src/blender.ts` (model and exchange), `apps/studio/src/main/blender.ts` (running Blender), `apps/studio/resources/blender/be_blender.py` (inside Blender), `apps/studio/src/renderer/src/studio/blenderEffects.ts` (editor).

1. The editor writes an **exchange file** (below). This is the contract between the two programs.
2. Blender runs in the background in two passes:
   - `blender -b --factory-startup -P be_blender.py -- build exchange.json` builds and saves `effect.blend`, with relative paths.
   - `blender -b effect.blend -P be_blender.py -- render exchange.json` bakes the simulation and renders PNG frames with transparency.

   The script reports progress as `BE_PROGRESS <stage> <done> <total>` lines, then `BE_DONE` or `BE_ERROR`. Cancel ends the process.
3. FFmpeg turns the frames into ProRes 4444 with alpha. The editor adds the video and its layer in one undo step.

Files live in `<media folder>\<project>\blender\<link id>\`:
- `effect.blend` and `exchange.json`
- `cache\` (baked simulation)
- `frames\`
- the videos

Old renders stay on disk, so undo can bring them back. They leave the media list when replaced.

### The exchange (version 1)

```text
{ version, kind: smoke|fire|liquid|cloth, params, fps, frames, render: {width, height},
  camera: { eye, target, fovYDegrees },          // the show camera: its picture is the canvas
  photo?,                                         // the building photo
  objects: [{ name, owner, role, mesh: {verts, tris, uvs?}, motion?, pin? }],
  domain?: { min, max, resolution },              // simulation box (smoke, fire, liquid)
  output: { blend, frames, cache } }
```

**Coordinates.** Before Effects' world is in metres: x right, y up, z toward the audience. 100 canvas pixels are 1 m, and the house front is at z = 0. Blender's world is (x, −z, y).

**Owners.** Every object has exactly one owner. `checkOwners` refuses an exchange that breaks this.
- `before-effects`: Blender never simulates it. These are:
  - the building, as holdout obstacles (they hide what's behind them but aren't drawn, because the real house is there);
  - the ground;
  - bodies with `motion`, played back from keyframes.
- `blender`: simulated by Blender: the emitter slab in front of each source area, or the cloth.

**Physics Before Effects already prepared.** Moving bodies in 3D layers (Rapier collapses, falling parts) on screen during the effect go to Blender with their prepared poses, resampled to Blender's frames. Smoke and water flow around the falling pieces, and the area those pieces replace is left out as a still obstacle. The 3D scene's fixed solids, such as the plinth the pieces land on, come along as still obstacles.

**Break apart.** Before Effects cuts the areas into Voronoi pieces, the same fracture as the built-in collapse. Each piece is `debris` owned by Blender and carries its `release`:
- the frame it lets go (top first when "lets go over" is set);
- its push toward the audience;
- its spin.

Blender holds each piece (animated) until that frame. Two keyed frames hand Bullet the push and spin, and it simulates from there. A dark `backdrop` shows where the pieces were.

**Cloth.** `pin` lists:
- the held vertices (the top edge);
- the handle's keyframes (a small tug toward the audience);
- the frame each held vertex lets go (left to right).

Blender reads pin weights every frame, so the sheet falls when they drop to zero.

**Look.** Rendered with EEVEE on a transparent background:
- Smoke is white with a little glow of its own, because on a projected house the projector is the only light.
- Fire glows by the simulation's flame values, from dark red to yellow-white. Blender's blackbody shading barely shows in EEVEE.
- Water is opaque blue with a clear coat.
- Emission is broken up by moving noise, so the source area's outline doesn't show.
- Smoke dissolves as it rises.
- The water stream stops after a burst. The simulation box is open at the front, sides and top, so water runs off instead of piling up against invisible walls.

## Agent API

| Method | Does |
|---|---|
| `blender.status` | found, path, version, running jobs |
| `blender.list` | links with their layers |
| `blender.effect` | `{kind, areas, seconds?, startSeconds?, quality?, params?}`; waits for the result |
| `blender.link` | `{file, seconds?, quality?}`: render your own .blend |
| `blender.update` | `{link}` renders again keeping edits; `{link, rebuild: {quality, seconds}}` rebuilds |
| `blender.open` | opens the .blend in Blender |
| `blender.importEditable` | `{link}`: bring a linked .blend in as editable 3D (or update it); returns the per-object report |

**Effect params** are declared once in `BLENDER_PARAMS`, which the inspector, the agent API and `be_blender.py` all read; times are in seconds:
- smoke: `color`, `density`, `swirl`, `linger`;
- fire: `fuel`, `density`, `swirl`, `linger`, `color` (smoke);
- liquid: `color`, `push`, `pourFor`;
- cloth: `color`, `revealAt`;
- shatter: `pieceSize`, `breakAt`, `stagger`, `push`, `spin`, `bounce`, `friction`, `seed`.

`blender.update` with `rebuild: {params, startSeconds, seconds, quality}` simulates again with new settings.

## Measured (this PC, Blender 5.2.2, 3 s at 30 fps)

| Job | Time |
|---|---|
| Smoke from the vent, draft | 82 s (tall box at resolution 96) |
| Fire on the garage door, draft | 37–39 s |
| Water pouring from the window, draft | 33–41 s |
| Cloth reveal over the garage door, draft | 20 s |
| Fire beside a Rapier garage collapse (45 played-back pieces), draft | 35 s |
| Same fire at full quality (1920×1080, resolution 160) | 94 s |
| Linked .blend, 60 frames at 1280×720 | 12 s; Update after editing it: 14 s |
| Break apart on the garage door, draft (≈60 pieces) | 18 s |

### Editable 3D (export mode)

`blender -b your.blend -P be_blender.py -- export export.json` does the following:
1. Classifies every object (see above).
2. Selects only what carries over.
3. Writes a GLB:
   - Y up, metres, +Z toward the audience: Before Effects' axes;
   - modifiers applied;
   - animation sampled over the link's frames;
   - lights included, cameras left out.
4. Reads the GLB back, so the report reflects what's really in the file.

The engine loads it with three.js's glTF loader and plays its animation from the layer's time (deterministic: any frame, any order).

## Limitations

- Blender has to be installed. Without it, the section offers **Choose blender.exe…** and nothing else changes.
- Coupling is one way: Blender's smoke, water and cloth react to Before Effects' moving pieces, but nothing pushes back on them.
- Depths are assumed, as for the other 3D features:
  - the emitter is a 6 cm slab just in front of the area;
  - the facade is 25 cm deep.
- Draft simulations are coarse, so smoke and fire look soft. Full quality is finer and slower.
- The cloth is a plain white sheet; it doesn't show the photo.
- A linked .blend uses its own camera. It lines up with the house only if it was set up to match.
- **Render at full quality** on an effect rebuilds it, which replaces edits made in Blender. **Update from Blender** keeps them.
