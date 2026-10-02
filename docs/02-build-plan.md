# Build plan (dependency-ordered, no scope reduction)

Milestones follow brief §21. Each increment is reviewable: one commit or a small series, with tests or a scripted check, and register entries moved to `prototype` / `implemented` / `verified` along with their evidence. Staging never removes scope, and a prototype is never described as the finished product.

## Milestone A — architecture risks, inventory, interaction design

| # | Increment | Status |
|---|---|---|
| A1 | Workspace, core model, operation system with undo, recipe engine with overrides, deterministic time/RNG, evaluation | **done** (21 unit tests) |
| A2 | Engine spike: composite, 3D at exact times, projector warp, verified encodes, determinism | **done** (spike report) |
| A3 | Capability register: schema, ~600 entries across 37 files, validator and report | in progress |
| A4 | First-time experience and one common creative task, prototyped in the real app with realistic content | next |
| A5 | Architecture, build plan, FTUE docs | **done** (this folder) |

## Current increment order (updated 2026-10-02, after the second brief; status as of the end of that day)

1. ✅ **B0 Launcher and packaging.** `Before Effects.exe` in the root and a desktop shortcut; packaged app with FFmpeg bundled; single instance; logs; process cleanup.
2. ✅ **B1+ Preview.** Resolution selector (Auto/Full/Half/Quarter/Eighth/Custom) and display zoom; Show / 3D projection / Projector views; transport (play/pause/restart/step/loop/range); overlays; frame cache with targeted invalidation; real-time vs cache-first; fps/dropped/cache stats; pop-out window.
3. ✅ (software; unverified on a real projector) **B4 Projector output window.** Full-screen on a chosen display, numbered identification patterns, guided alignment, output resolution independent of preview. Reported unverified until real hardware is tested.
4. ✅ **B2 Own content.** Photo import and tracing (draw, edit, name, group, suggested repeats); images, video (proxies for preview, originals for export), text, stereo audio tracks with mixer, and "Move with the beat".
5. ✅ (Drive tested against a stand-in folder; Drive for desktop isn't installed here) **B5 Background rendering.** Snapshot jobs in a hidden render window; queue, progress, cancel and retry; audio mixdown in exports; explicit export resolution; Drive synced-folder copy with retry.
6. ✅ **B6 Assistant.** Verify subscription CLI behaviour; MCP server; live changes with per-request undo (selective undo keeps later work); follow-ups. Verified live with Claude Code and Codex, each on a personal subscription. See docs/05.
7. ✅ (exporter script not yet run inside real After Effects) **C-early After Effects import.** Exporter script, JSON importer, direct `.aep` reader, compatibility report, proven on sample projects.
8. ✅ **C Simulation.** GPU smoke solver and FLIP water with background preparation and checkpoints; "Smoke rising", "Fill with flowing water" and "Crack and rebuild" effects. See docs/07.
9. ✅ kit ready, ⏳ human sessions pending **B7 Usability kit.** Test build, tasks using personal content, observer sheet. Human results are reported separately from automated checks.

## Milestone B — one complete guided path (one projector)

Order is by dependency. A novice usability check runs at the end of each increment, not just once at the end.

1. **B1 Studio shell.**
   - The guided route bar: Space → Content → Animate → Preview → Export/Play.
   - Central WebGPU canvas with "Content", "On the building" and "Projector view" modes.
   - Simple timeline with recipe clips, contextual inspector, undo/redo, autosave + recovery, save/open.
   - The sample town hall opens immediately.
2. **B2 Set up the space.**
   - Import a photo: honestly framed as a tracing reference, not 3D or calibration.
   - Trace regions with polygon/Bezier tools, plus snapping and edge-snap assist.
   - Name and classify regions; accept suggested repeated groups ("9 similar windows").
   - Build a simple measured proxy (flat facade first).
3. **B3 Animate with recipes.**
   - Visual library with animated thumbnails previewed on the selected region.
   - Everyday-language search.
   - Apply in ≤ 3 actions, then 3–5 controls, then More controls / Edit animation.
   - Override indicator and "Reset to effect"; apply to many.
   - Recipes: trace with light, light up one after another, pulse, color wash, light sweep, reveal (wipe along regions).
4. **B4 Projector setup and calibration.**
   - Output window on a chosen display, simulated when there is no second display.
   - Numbered target points with plain instructions; drag in the projector window.
   - Residual/alignment feedback; test patterns; lock, save and restore calibration versions.
5. **B5 Guided export.**
   - Choices: "Save a video", "High-quality master", "Transparent animation", "Files for my projector".
   - Estimates of time and size.
   - Background render from an immutable snapshot in a hidden window; render/encode/verify phases in plain language.
   - Verification report, show in folder, export history.
   - Google Drive through the synced-folder route.
6. **B6 Assistant v1.**
   - MCP server and Claude Code / Codex CLI adapters.
   - Preview → accept; change summary; follow-ups; bounded to the selection.
   - Honest failure.
7. **B7 Novice journey test.**
   - Run the §0.10 tasks with representative first-time users.
   - Record time, completion, confusion points and recovery.
   - Fix issues before expanding the UI.

**Exit:** a novice sets up a simple surface, places and aligns a projector, applies and adjusts an editable animation, saves and reopens, and exports a master and a projector video with recommended presets. Verify with real projection when hardware exists.

## Milestone C — creative foundation

- Graph editor: value and speed graphs, handles, easy ease, roving keyframes, motion paths.
- Expression engine:
  - QuickJS-WASM sandbox, AE-compatible API subset, time bound, cycle detection.
  - Native fast paths for recipe rigs.
  - Expression controls.
- Masks and mattes UI: modes, feather, expansion, track mattes, reusable matte sources.
- Shapes:
  - Operators: repeater, trim, merge, offset, round, twist, pucker/bloat, wiggle.
  - CanvasKit path ops, SVG import, shape↔mask.
- Text: HarfBuzz shaping, variable fonts, per-character animators and selectors, text on path, words-across-columns tool.
- Effect stack UI and the core effect families: blur, glow, color, gradients, fractal noise, distortion basics, transitions that follow regions.
- Shader-based advanced blend modes; layer styles.
- Nesting / pre-compose with pre-render cache and invalidation.
- Audio:
  - Tracks, waveforms, fades and levels.
  - Beat/onset/BPM analysis, frequency bands, convert-to-keyframes, "Move with the beat".
  - Deterministic mixdown.
- Reusable rigs and presets; favorites; styles.

## Milestone D — advanced creative

- Rich 3D:
  - glTF/OBJ/FBX import, PBR materials, IBL, cameras and lights UI.
  - Extruded text and shapes, depth of field, motion blur via temporal supersampling.
  - Shadow catchers.
  - Tunnel/recess depth-illusion tool with the audience viewpoint.
- Simulations: Rapier fracture/rebuild, GPU particles with region emitters and checkpoints, rain/snow, water and caustics looks.
- Vision sidecar:
  - Point, planar and mask tracking; stabilisation; camera solve.
  - SAM 2 roto and refine edge.
  - Content-aware fill (ProPainter, with LaMa as fallback); paint/clone.
  - Puppet pins.
- Multi-pass: depth, normals, IDs, Cryptomatte, multi-channel EXR.
- OCIO/ACES working spaces, LUTs, gamut and clipping diagnostics.
- The remainder of the effect inventory.

## Milestone E — installation and live

- Multi-projector: edge blending, black-level compensation, per-output color matching, numbered test patterns, export bundles with a manifest.
- 3D model-based calibration (solvePnP with residuals); camera-assisted / structured-light alignment; curved, dome and panoramic surfaces.
- Live show workspace: cue list, transitions, master blackout, preload, output health, crash recovery, control UI kept off projector feeds.
- Spout / NDI / MIDI / OSC.
- Google Drive direct OAuth with resumable upload and retry.
- **Architecture gate:** confirm multi-output sync and latency on real hardware. If needed, move the render engine to a native Dawn/wgpu process (WGSL and core unchanged).

## Milestone F — close gaps, prove the shows

- Clear every register entry that is still `not-started` or `unresolved`. Exclusions need the user's agreement.
- Build and pass acceptance shows 1–7 (brief §22) with recorded tolerances, residuals, drift, dropped frames, throughput, memory/VRAM, and preview-vs-export differences.
- Packaging and installer, keeping project-format migration and exported appearance unchanged.
