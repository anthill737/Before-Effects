# Before Effects

A desktop studio for **3D projection mapping**: trace a building, put pictures, video and animated
effects onto its windows, doors and walls, add 3D objects with real physics, arrange scenes into a
show, preview it live and export it for the projector.

> Copyright © 2026 Hillside Ventures LLC. All rights reserved. See [LICENSE](LICENSE).
> The source is visible for reference only; no licence to use it is granted.

## What it does

- **Building areas.** Trace areas on a photo of the building: rectangles or outlines, holes, soft edges and groups. Areas are traced once and shared by every scene.
- **Content in areas.** Drag a picture, video or animation onto an area. It appears clipped to the area straight away.
  - With several areas you choose **repeat in each** or **span across**.
  - Adjust crop, fit, position, timing, looping, speed, blend and sound.
- **Scenes and the show.** Duplicate a scene and swap its content without retracing anything. Arrange scenes with cuts or crossfades.
- **Internal 3D.** Give an area thickness, or make it collapse and rebuild. The project stores editable objects, materials, lights with shadows and cameras.
  - Rigid-body physics (gravity, mass, friction, bounce, collisions) uses Rapier.
  - Motion is prepared ahead of time, so preview, seeking and export always match.
  - An orbit view lets you inspect the scene from any side.
- **Timeline.** Move and resize clips, drag collapse and rebuild times, and keyframe 3D values with easing presets.
- **Preview and export.** A live WebGPU preview with adjustable resolution, and a projector output view with calibration. Exports render in the background from a frozen snapshot: H.264, ProRes or HAP.
- **Also included:**
  - 2D smoke and water simulations
  - stereo audio with beat detection
  - an After Effects project importer with an honest compatibility report
  - an optional assistant that runs on the user's own Claude Code or Codex sign-in (never an API key)

Status, evidence and known limits: [docs/09-status-report.md](docs/09-status-report.md) and
[docs/10-projection-workflows.md](docs/10-projection-workflows.md).

## Run it

Requirements: Windows 10/11, Node 24+, pnpm 11, and FFmpeg (`winget install Gyan.FFmpeg`).

```sh
pnpm install
pnpm dev                              # the studio, with hot reload
pnpm test                             # unit tests
pnpm typecheck
pnpm --filter @be/studio package      # packaged app in build/app
pnpm --filter @be/studio uitest       # journey tests that drive the real UI, with screenshots
```

To get a double-click launcher, run `tools\launcher\build.cmd` once (Visual Studio Build Tools). It produces `Before Effects.exe` in the repository folder. The launcher:
- rebuilds the app when the sources change
- checks prerequisites
- keeps a single copy running
- stops background processes when the app closes

**Data folder:** renders, caches and test output go to a `Before Effects` folder at the root of drive D: when there is one, otherwise to `Documents\Before Effects`. The docs call this the *data folder*. Shows are saved in `Documents\Before Effects\Projects`. None of this is stored in the repository.

## Layout

```
packages/core     project model, undoable operations, time, keyframes, areas, scenes, 3D scene model, evaluation
packages/engine   WebGPU compositor, effects, three.js 3D, Rapier physics, simulations, projector output
packages/media    FFmpeg presets, encoding, probing, output verification
packages/aep      After Effects project reader
apps/studio       Electron app (main / preload / React renderer) and journey tests
tools/            launcher, After Effects exporter script, capability register tools
docs/             brief, architecture, plan, status, capability register
```

## Third-party components

Dependencies are installed from npm under their own licences. Among them:
- three.js (MIT)
- Rapier (Apache-2.0)
- Electron (MIT)
- React (MIT)

FFmpeg is installed separately; it is not part of this repository.

The After Effects test projects in `packages/aep/test/fixtures` come from py_aep (MIT). Its licence is included alongside them.
