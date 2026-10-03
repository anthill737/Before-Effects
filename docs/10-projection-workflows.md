# Projection workflows: areas, content, scenes and internal 3D (2026-10-02)

Scope follows the projection-first brief: Before Effects is built for 3D projection mapping. After
Effects import stays, with an honest compatibility report, but it doesn't decide the design.

## What you do in the app

**1. Areas** (shared by every scene)
- Draw an outline or a quick rectangle on the building photo, and say what it is (window, door, wall…).
- Drag corners. Drag the "+" on an edge to move that edge, or click it to add a corner. Alt-click a corner (or select it and press Delete) to remove it.
- Drag inside an area to move it. Ctrl+D duplicates it. Cut a hole in it, for example a window out of a wall.
- Zoom with Ctrl+wheel. Points snap to nearby corners.
- Set a soft edge and grow/shrink. Rename areas and groups in place.
- Group areas ("Upstairs windows"). A group follows its members wherever it is used.

**2. Content** (belongs to the current scene only)
- Drag a picture, video or animation onto an area, either in the picture or in the area list. It appears clipped to the area straight away.
- With several areas selected, you choose:
  - **Repeat in each area**: a full copy per area. The sound plays once, not once per area.
  - **Span across areas**: one continuous image across all of them.
- **Placement:** fit, fill or stretch; size, position, rotation and crop.
- **Timing:** start, length, trim, speed, loop, fades.
- **Look and sound:** strength, blend, soft edge for this scene only, and sound level.
- Replace the media while keeping placement and timing. Copy an assignment to other areas or groups. Change stacking order.
- A note always separates "this scene's adjustment" from "edit the shared outline".

**3. Scenes and the show**
- Scene tabs. "+ Scene" makes a copy of the current scene (same areas, independent content) or an empty one.
- The Show tab lines scenes up with lengths and cuts or crossfades. It plays and exports as one composition, and sound from every scene is mixed and crossfaded.

**4. 3D**
- On any area: **Give it thickness (3D)** or **Collapse & rebuild (3D)**. Collapse & rebuild is also an animation card you can drag onto an area.
- Either one creates an editable 3D scene shown through a show camera that lines the building front up exactly with the canvas. The scene contains:
  - the area as a solid with the building photo on its front
  - a dark inside behind it
  - a ledge (a plinth when the area starts near the ground)
  - a shadow-only ground
  - a key light and a soft fill
- The inspector lists the objects. You can add a box, a ball, a ledge or a spot light.
- Gravity strength and direction are per scene. Pieces and effects can be **contained within the area** or **extend beyond** it; projector keep-light-off areas apply either way.
- Per object:
  - position, turn, size and thickness
  - look: building photo, colour, or shadows only; tint, glow, roughness
  - physics: none, fixed, or falls and collides; mass, friction, bounce
  - breaking apart: piece size, collapse time, rebuild time and duration, push, tumble, shuffle
  - light: kind, brightness, colour, shadows, softness, aim and beam width
- Values marked ◆ can be keyframed at the playhead.
- **3D projection view:** orbit, pan and zoom around the actual 3D scene. It shows the ground grid, the show camera's frame, light markers and the photo behind for orientation.

**5. Timeline**
- Drag a bar to move it. Drag its ends to change its length; for layers, the start end trims.
- On 3D layers:
  - ▼ (collapse) and ▲ (rebuild, with its duration band) are draggable.
  - Keyframes appear as ◆: drag one to retime it, or click it for easing (smooth, steady, start slowly, arrive slowly, jump) or to delete it.

## How it works

- **Model** (`packages/core/src/world3d.ts`): `project.scenes3d`.
  - Units are metres, with 1 canvas pixel = 1 cm on the building front.
  - Objects carry animatable transforms and optional geometry, material, physics, fracture and light.
  - Changes go through undoable operations (`scene3d.*` and `object3d.*`).
  - Duplicating a scene copies its 3D scenes.
  - Venue and calibration geometry stays separate: 3D objects never move traced areas.
- **Fracture:** a seeded Voronoi split of the area outline, so the same settings always give the same pieces. Window holes stay empty.
- **Physics:** Rapier (`@dimforge/rapier3d-deterministic-compat` 0.21.0) in `packages/engine/src/physics.ts`.
  - The scene becomes a plain description: shapes, masses, friction, bounce, gravity, releases with push and spin, eased rebuild paths, and animated obstacles as kinematic bodies.
  - Its key covers only what affects motion, so lights, colours and the camera never re-prepare it.
  - Motion is prepared in the background, 4 steps per frame. It is stored per frame in memory and on disk (`Cache\sims\<key>\motion.bin`).
  - Preview, seeking, reopening and export all read the same motion. Export waits until it is ready.
- **Rendering** (`packages/engine/src/scene3d.ts`):
  - three.js WebGPU runs on the compositor's GPU device. The scene is rebuilt from the data only when shapes change; per-frame values come from keyframes.
  - Edits to a 3D scene invalidate only the frames of the layers that show it.
  - Preview resolution changes only the render size: it never affects physics, project size or export size.

## Acceptance evidence (packaged app)

All runs used the packaged `build/app/Before Effects.exe` built from the final code on 2026-10-02. Each workflow ran as two separate app launches: build and save, then reopen, seek and export. Reports and screenshots are written to `<data folder>\Renders\acceptance`.

**Workflow A: 12 + 2 steps pass.**
1. Photo → a window, a door and a wall, with the window and door cut out of the wall.
2. Window duplicated twice with Ctrl+D and dragged into place, then grouped.
3. A picture **spanned** across the windows (three different parts of one gradient), a video **repeated** in each (the same image three times), a video on the door from the area list, and "Trace with light" on the wall.
4. Adjusted crop, size, position, looping, soft edge, start and length.
5. Scene duplicated, its span replaced, and the original confirmed unchanged on the same traced windows.
6. Show arranged as a 6 s cut followed by a 6 s scene crossfading in.
7. Saved, then reopened in a new process with every setting kept.
8. Seeking returned the same picture. Exported 330 frames at 1600×1000 with sound in 13.2 s, and the file checks passed.

**Workflow B: 10 + 2 steps pass.**
1. Wall traced with 2 windows cut out, then given 40 cm thickness.
2. Collapse & rebuild switched on.
3. Settings changed: piece size 90 cm (88 → 56 pieces), gravity 12 m/s², mass 3000 kg, friction 0.5, bounce 0.3.
4. 4 s after the collapse, from the prepared motion:
   - 22 of 56 pieces lie on the ledge and none are inside it
   - 32 rolled off onto the ground and none went below it
5. Moving the key light changed the lower picture by 27.6/255.
6. The orbit view changed the picture.
7. Collapse time dragged from 1 s to 2 s and rebuild time from 5 s to 5.5 s on the timeline.
8. Light position keyframed at two times, with easing set from the timeline.
9. Saved, then reopened in a new process with everything kept.
10. Exported 240 frames in 6.4 s. At three moments the export matched the preview to within 0.44–0.54/255 average block difference, while a different moment differed by 23/255.

`Before Effects demo - workflows A and B.mp4` (19 s) joins the two app exports.

**Unit tests: 213 pass.** They cover these 3D and physics facts:
- Fracture covers the area minus its holes.
- The physics key ignores lights.
- Pieces land on the ledge, the same way each time, and rebuild exactly.
- Gravity, bounce and piece size change the motion.
- Duplicated scenes get their own 3D scene.
- A 3D edit invalidates the right preview frames.

## Measurements

Measured on the packaged build, with the results in `perf-report.json`:
- Machine: Intel Core Ultra 9 275HX, 24 threads, 31 GB RAM, NVIDIA (Blackwell) GPU.
- Project size: 1600×1000.

| Scene | Preview, full size, uncached | Cached | Half size, uncached | Other |
|---|---|---|---|---|
| 3D collapse: 57 pieces, ledge, inside, ground, 2 lights with shadows, 8 s | 29.8 fps (min 27, 0 skipped) | 29.9 fps | 29.4 fps | Physics: 228 ms to prepare 241 frames from scratch, 2 ms to load from disk. A light edit applies in 0.6 ms and the full-size frame renders in 30 ms |
| Video show: 2 scenes crossfading, 4 videos + picture + animation, 11 s | 27.3 fps (min 12, 5 skipped) | 29.8 fps | 29.6 fps (6 skipped) | Crossfade frame renders in 23 ms |

- **Targets and export times:** the target is 30 fps. Exports took 13.2 s for the 11 s show (H.264 with sound) and 6.4 s for the 8 s 3D clip.
- **Memory:**
  - 691 MB across processes with the 3D project.
  - 1334 MB with the video show, of which the main process was 524 MB, mostly FFmpeg decoder buffers.

These are measurements on one machine. No comparison with After Effects has been made, so none is claimed.

## Limits and what's next

- **Media:** no AtmosFX files are on this PC. The workflows used generated sample footage, named "(generated, not AtmosFX)", so AtmosFX import is untested.
- **Physics:**
  - Pieces are convex hulls, slightly smaller than drawn, so they don't start overlapping.
  - Fixed areas with openings use a triangle mesh.
  - Pieces don't break further when they land.
  - Rebuild is an eased path back home, not a simulated reassembly.
- **Rendering:**
  - Pieces show the building photo on their front only; sides use a darkened tint.
  - Lights use three.js physical units; spot and bulb brightness are scaled by a fixed factor.
- **Not built yet:**
  - smoke and water in 3D (they are still 2D simulations)
  - a full keyframe lane and curve editor for layers (3D values have keyframes, easing presets and timeline diamonds)
  - the external-agent API and MCP adapter beyond the current bridge
  - multiple projectors and edge blending
- **Needs checking:**
  - main-process memory while decoding several videos (524 MB)
  - the large renderer bundle (8.4 MB, mostly Rapier's inlined WebAssembly)
- **Needs a real projector and people:** physical alignment and usability sessions have not been done.
