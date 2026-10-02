# Capability Register — schema and authoring rules

The capability register is the traceable inventory required by brief §2. It lists the After Effects capabilities and the projection-mapping capabilities that are considered for this product. Each entry records how Before Effects will provide that capability, and how a first-time user reaches it.

**Scope (brief 2026-10-02, projection scope).** The product does not need general After Effects parity. Entries that serve projection workflows stay required. Entries that exist mainly for After Effects parity are `deferred`: valid capabilities that are not needed now and can be revisited later (see "Projection scope" below).

- One YAML file per area: `docs/register/<area>.yaml`. Each file is a YAML list of entries.
- `pnpm register:check` validates every file against this schema. `pnpm register:report` regenerates `docs/register/REPORT.md`, which holds status counts, the milestone breakdown and open questions.
- When implementation work lands, update `status` and `evidence`. An ID is permanent. Never reuse or renumber one. If an entry is replaced, set `disposition: superseded` and point `superseded_by` at the replacement.

## Entry fields

```yaml
- id: fx.distort.corner-pin          # stable dotted slug: <domain>.<area>.<feature>, lowercase, hyphens inside words
  name: Corner Pin                   # artist-facing name of the capability
  sources:                           # where the capability comes from (brief source register S01–S37, or "brief" for product requirements)
    - ref: S12
      item: Corner Pin               # exact Adobe/vendor name
      category: Distort              # Adobe effect category or guide section
      adobe_support:                 # from the S02 effect-list support matrix when known; omit the block when not applicable
        gpu: true                    # true | false | null (unknown)
        bpc: [8, 16, 32]             # bits per channel the Adobe effect supports; [] when unknown
        mfr: true                    # multi-frame rendering supported: true | false | null
      checked: true                  # true only if you confirmed this item against the live source page during authoring
  artist_can: >-                     # what the artist can do, in plain words
    Pin the four corners of any layer to four points so it looks painted onto a skewed surface.
  projection_example: >-             # one concrete projection-show use
    Fit a looping video into a window that the photo shows at an angle.
  controls:                          # the individual controls the equivalent must offer (consolidate trivial ones)
    - { name: Corners (4 points), type: point2d[4], animatable: true }
    - { name: Expand output, type: bool, animatable: false }
  animation: >-                      # keyframe / expression / tracker / audio-drive requirements
    Every corner keyframable and expression-linkable; accepts planar-tracker and region-corner data.
  dependencies: [anim.keyframe.core, track.planar]   # other register IDs this needs (may reference IDs in other files)
  implementation: >-                 # proposed implementation or integration (see "Architecture context" below)
    WGSL projective-warp pass (homography from 4 points), bicubic resampling, premultiplied alpha.
  io: >-                             # import/export implications ("none" is fine)
    none
  limitations: >-                    # known limitations / honest caveats
    Not a substitute for projector calibration (map.calib.*); artistic only.
  disposition: required-equivalent   # required-equivalent | required-integration | deferred | superseded | unresolved | excluded
  superseded_by: null                # register ID when disposition = superseded (the target must cover the useful outcome)
  exclusion_reason: null             # required when disposition = excluded; exclusions also need user agreement (record it)
  deferred_reason: null              # required when disposition = deferred (one sentence: why it is not needed for projection workflows now); omit otherwise
  milestone: C                       # A–F per brief §21 (see below)
  beginner:
    action: >-                       # the plain-language action / entry point a first-time user sees
      "Pin to corners" — drag four handles on the canvas; or "Fit to this region".
    defaults: >-                     # the useful defaults applied automatically
      Corners start at the layer bounds; snap to region corners when a region is selected.
    automation: >-                   # technical work the app performs on the user's behalf
      Auto-detects the four corners of a selected region and pins to them.
    usability_check: >-              # a measurable novice check for the common workflow
      A first-time user fits a video into a skewed window in under 30 s without opening the inspector.
  acceptance: >-                     # acceptance scene (brief §22 show number or a named mini scene) and what it proves
    AS-1 and mini scene "pin-window": video pinned to a window region; export matches preview within tolerance.
  status: not-started                # not-started | designed | prototype | implemented | verified
  evidence: []                       # list of links/paths to tests, scenes, renders, usability notes once they exist
```

### Field rules

- **id**: domain prefixes:
  - `ux.*`: guided experience
  - `proj.*`: projects, compositions, assets and editing
  - `anim.*`: keyframes, graph editor, time
  - `expr.*`: expressions, controllers and rigs
  - `mask.*`: masks, mattes, blending and layer styles
  - `shape.*`: vectors, paths and paint
  - `text.*`: text
  - `3d.*`: 3D workspace
  - `pass.*`: depth and multi-pass compositing
  - `fx.<category>.*`: effects
  - `track.*`: tracking, roto, cleanup and puppet
  - `audio.*`: sound and music
  - `color.*`: color management
  - `map.*`: surfaces, venue and calibration
  - `out.*`: projector outputs, blending and interchange
  - `render.*`: render and export
  - `deliver.*`: delivery and upload
  - `preview.*`: preview, cache and performance
  - `show.*`: live show operation
  - `tool.*`: projection-specific creative tools
  - `ai.*`: external-agent API and MCP adapter (the embedded AI assistant entries are deferred)
- **sources**: an effect from Adobe's catalog must cite `S02` (the effect-list matrix) plus its category page (S11–S19, S35–S37). Cite the brief section (e.g. `brief §15`) for product-only requirements.
- **disposition**:
  - `required-equivalent`: Before Effects provides a functional equivalent.
  - `required-integration`: provided through an identified external engine, model or service. Name it in `implementation`.
  - `deferred`: a valid capability that is not needed for projection workflows now. Revisit it later. It needs a short `deferred_reason`. Keep `status` and `evidence` as they are: a deferred entry that is already `prototype` or `implemented` keeps that status, and its evidence stays valid.
  - `superseded`: a modern equivalent covers the useful outcomes. Name it in `superseded_by` and explain in `limitations`.
  - `unresolved`: relevance is not yet decided. State the open question in `limitations`.
  - `excluded`: needs a reason and the user's agreement. Agents must not mark anything excluded on their own; use `unresolved` instead.
  - Being listed in a menu does not make a capability covered.
- **deferred_reason**: required when `disposition: deferred`. State why the capability does not serve a projection workflow now, and name what stays required in the same area when that helps. To bring an entry back, set `disposition` to `required-equivalent` or `required-integration`, remove `deferred_reason`, and check its milestone.
- **milestone** (brief §21, dependencies may justify a reorder):
  - A: architecture risks, inventory, interaction prototypes
  - B: one complete guided path (surface, projector calibration, editable animation, save/reopen, master and projector export)
  - C: creative foundation (graph editor, expressions, masks/mattes, shapes/text, effect stack, nesting, audio, rigs)
  - D: advanced creative (rich 3D, simulations, tracking/roto/cleanup, multi-pass, color workflows, rest of the effect inventory)
  - E: multi-projector, live controls, advanced calibration, interop playback, delivery integrations
  - F: gap closure and proof of target show workflows
- **beginner.action**: a niche capability can be reached through an outcome-oriented recipe instead of its own button. In that case write e.g. `Reached through the "Make it glow" recipe → More controls`. Every capability still needs *some* path a novice can understand, or a stated reason why it lives only in advanced tools.
- Keep each entry compact: one to three sentences per prose field. Avoid marketing language.

## Projection scope (brief 2026-10-02)

The product owner superseded the earlier goal of exhaustive After Effects parity. Required scope is what projection shows need:

- **Building areas**: photos, geometry, tracing, reusable areas, depth, masks (feather, expansion, holes), naming and grouping.
- **Content on areas**: assign videos, pictures, animations and effects to areas (repeat per area or span across areas, fit, fill, crop, position, trim, loop, speed, audio level, several layers per area, replace asset, copy to other areas). Scenes are built from the same areas and arranged with transitions on a show timeline.
- **Projectors**: calibration, warping, multiple outputs, edge blending.
- **3D**: editable objects, materials, cameras, lighting, shadows, Rapier rigid-body physics (gravity, mass, friction, bounce, forces and impulses, collisions).
- **Projection effects**: tracing, sequencing, depth illusions, collapse and rebuild, smoke, water.
- **Time**: timeline editing, keyframes, easing, music synchronisation, show playback.
- **Media and tools**: AtmosFX and other media import, deep optional Blender integration, adjustable-resolution previews, background rendering, export, local and Google Drive delivery.
- **External agents**: a standing local external-agent API and an MCP adapter. The embedded AI assistant is deferred.
- **Still required**: editable After Effects import with a clear compatibility report (arbitrary After Effects support must not drive scope), real 3D smoke and liquids through an established solver, real projector validation, and first-time-user usability testing.

Rules:

- Mark an entry `deferred` when it serves After Effects parity only. Do not change `status` or `evidence` when deferring.
- `pnpm register:check` requires `deferred_reason` on every deferred entry and warns when an active (`required-*`) entry lists a deferred entry in `dependencies`. Resolve the warning by un-deferring the building block, or by dropping the dependency edge.
- `pnpm register:report` shows deferred counts per area, per milestone, and the deferred entries that already have prototype or implemented status.
- New entries for this scope cite `ref: "brief 2026-10-02 (projection scope)"`.

## Architecture context (use this for `implementation` fields)

Full rationale lives in `docs/01-architecture.md`. Summary:

- **App shell**: Electron (Chromium) + TypeScript + React. Background render jobs run in hidden renderer processes using an immutable project snapshot.
- **Core** (pure TypeScript, runs headless under Node for tests):
  - Versioned project model.
  - **Operation system**: typed, serializable, undoable ops. The UI, guided actions, recipes, scripts and the AI assistant all use the same ops.
  - Integer time in *flicks* (1/705,600,000 s), property evaluation (keyframes, Bezier/hold/linear interpolation, spatial paths), expressions, and stateless seeded RNG.
  - **Recipe engine**: a recipe generates real layers, keyframes, effects and expressions from a few creative parameters. Manual edits to generated items are tracked as overrides, so regenerating never silently discards them.
- **Engine**: WebGPU + WGSL compositor.
  - Working buffers: `rgba16float`, scene-linear, premultiplied alpha.
  - Every effect is a pass (or small pass graph) that declares its bounds expansion, temporal dependencies, color-space expectation and precision.
  - 3D: three.js WebGPU renderer (TSL node materials) for PBR, IBL, shadows, glTF/GLB/OBJ/FBX import, and render passes (depth, normals, object/material IDs).
  - Rapier (deterministic WASM physics) for rigid-body fracture and collapse.
  - GPU compute particles with deterministic seeds and checkpointed state for seek and replay.
- **Vector & text**: Skia CanvasKit (WASM) for path ops (booleans, offset, stroke-to-path, dash, trim); HarfBuzz (harfbuzzjs) for shaping, variable-font axes and glyph outlines; analytic-AA or MSAA path rasterization on the GPU.
- **Media**: FFmpeg (full GPL build, personal use allowed) as a sidecar process for probe/decode/encode.
  - Codecs: H.264/HEVC (NVENC and x264/x265), ProRes 422/4444, DNxHR, HAP family.
  - Image sequences: PNG/TIFF/EXR.
  - WebCodecs for fast preview decode where it is exact enough.
  - Multi-part / multi-channel EXR and Cryptomatte go through the OpenEXR Python bindings.
- **Color**: shader-side analytic transforms for common spaces. OpenColorIO (PyOpenColorIO sidecar) bakes LUTs for OCIO/ACES configs. `.cube` LUT import.
- **Vision/ML sidecar**: Python (uv-managed venv, CUDA on the RTX 5070 Ti).
  - OpenCV: tracking, homography, solvePnP calibration, stabilization.
  - SAM 2: segmentation propagation (roto).
  - ProPainter / LaMa: content-aware fill. Non-commercial licences are acceptable because this is personal use.
  - Depth Anything: depth maps.
  - pycolmap or Blender: camera solve.
- **Optional engines**: Blender headless (GPL OK for personal use) for camera solve, cloth/fluid/smoke sims baked to caches, and Cycles hero renders.
- **Audio**: Web Audio for preview. Deterministic offline mixdown is muxed by FFmpeg. Analysis (FFT, onsets, beats/BPM, frequency bands) runs in a worker and is cached so preview and export see identical data.
- **Mapping**: three things are kept distinct:
  - The **venue**: physical geometry, named regions, projectors and versioned calibration.
  - The **show**: venue-independent creative content that targets region *roles*.
  - **Bindings** from roles to the regions of a specific venue.

  Projector output is the venue geometry rendered from the calibrated projector camera, with content applied through UV coordinates and/or audience-viewpoint projective texturing. After that come output masks, blending, output color correction and a residual mesh warp. Creative warps and masks are never the same objects as calibration warps and output masks.
- **Outputs / live**: one full-screen window per projector. Spout and NDI through native addons. MIDI through Web MIDI. OSC over UDP in the main process.
- **External agents**: a standing local API (loopback only, started with the app) exposes the operation registry, and a local MCP adapter sits on top of it, so the user's own agent (Claude Code, Codex or any MCP client) can drive the app. No API keys are used or stored. Every agent edit is an ordinary undoable operation. The embedded AI assistant panel, with its provider adapters that launch `claude -p` or `codex exec`, is deferred.
- **Delivery**: local save. Google Drive through the Drive-for-desktop synced folder first, with a direct OAuth resumable-upload option.
- **Product-level rules**:
  - Deterministic time.
  - Seeded randomness.
  - Shared evaluation semantics for preview and export.
  - Mapping, blending and output color correction are never applied twice.
