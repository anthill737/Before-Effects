# Architecture

Status: **decided for milestone A–B**, with the evidence below. The decision is revisited at the milestone E gate, where multi-projector live output is the remaining risk.

## 1. Inputs that shaped the decision

| Input | Value |
|---|---|
| OS / machine | Windows 11 Home; Core Ultra 9 275HX (24 cores); 32 GB RAM; RTX 5070 Ti Laptop (12 GB, Blackwell) + Intel iGPU; 2560×1600 display |
| Projectors | 1 first, multi later |
| Resolution / rate | up to 4K/60 per output (assumed) |
| Show length | up to ~20 min (assumed) |
| Priority | export first, live later (default) |
| Licensing | personal use; GPL and non-commercial models allowed |
| AI | user subscriptions (Claude / ChatGPT), no API keys |

## 2. Options compared

| | A. Extend Blender | B. Game engine (Godot / Unreal) | C. Native C++/Rust + Qt/egui | **D. Hybrid: Electron + TypeScript + WebGPU engine + native sidecars** |
|---|---|---|---|---|
| AE-style 2D layer compositing and effects | Weak (node compositor, VSE) | Weak; must be built | Build everything | Built in TS/WGSL (spike proves the core) |
| True 3D, PBR, glTF/FBX | Excellent | Excellent | Build or embed | three.js WebGPU on the same GPU device (spike proves it) |
| Tracking, roto, sims, EXR, OCIO | Excellent | Poor | Libraries | Python sidecar (OpenCV, SAM 2, PyOpenColorIO, OpenEXR); Blender as an optional headless engine |
| **Radically easy UI** (the release gate) | Poor: expert UI, limited Python UI API, fighting it forever | Medium | Medium, slow to iterate | **Strongest**: fastest path to a polished, approachable, testable UI |
| Frame-accurate offline export | Good | Godot Movie Maker OK; Unreal MRQ good | Full control | Proven: exact flick times, verified encodes, order-independent hashes |
| Live multi-projector output | Weak | Strong (Unreal nDisplay) | Full control | Adequate for 1 projector; multi-output sync and Spout/NDI need a milestone E spike |
| Licensing / size | GPL; ~2M-line C++ fork to maintain | Unreal royalty / huge; Godot MIT | Your own | MIT/BSD core; GPL sidecars allowed (personal use) |

**Decision: D, the hybrid.** It is the only option where the ease-of-use requirement and the breadth requirement are both realistic for this team, which is one person plus an AI builder. The things a browser-based engine cannot do well (ML, vision, EXR, OCIO, camera solves, heavy sims, pro codecs) are handled by mature native engines running as separate processes. This is not "browser tech because it's quick":
- WebGPU here is Chromium's Dawn talking to D3D12 on the NVIDIA GPU, with 16-bit float render targets and compute.
- The shading language (WGSL) is portable to native wgpu/Dawn.

**Exit ramp.** The core (TypeScript, pure) and the shaders (WGSL) carry over unchanged to a native Dawn or wgpu render process. If milestone E shows that Chromium limits multi-output sync, 8K throughput or zero-copy NDI/Spout, the render engine moves out of the renderer process and the UI and core stay as they are.

## 3. Milestone A spike evidence (2026-10-01)

Command: `pnpm --filter @be/studio spike`. Report: `<data folder>\Renders\milestone-a\spike-report.json`.

| Proof | Result |
|---|---|
| GPU | WebGPU adapter: NVIDIA Blackwell, with `float32-filterable` and `timestamp-query` |
| Compose layers | Region-masked wall wash, sequence-lit windows with glow, light trace with trim paths, 3D layer masked to the door. Linear light, premultiplied. |
| 3D at exact times | three.js WebGPU renderer on our device; scene is a pure function of t; PBR with a shadow-casting light |
| Warp output | Projector output through the calibration homography, with an alignment-grid overlay |
| Encode usable video | Each output verified by ffprobe (resolution, rate, frame count, duration, alpha, sound): H.264 1080p (90 frames, ~39 ms/frame render+encode), ProRes 4444 with alpha, projector-warped H.264, HAP Q |
| Determinism | Frame 45 rendered three times in a shuffled order gives identical SHA-256; save → reopen gives identical pixels |

Known gaps from the spike, each tracked in the register:
- Advanced blend modes beyond normal/add/screen/multiply.
- Adjustment-layer masks.
- 3D layers in the 2D compositor's camera.
- The CPU half-float conversion slows ProRes. Fix: convert on the GPU.

## 4. Package boundaries (separately testable, brief §20)

```
packages/core     pure TS: project model, operations/undo, time, keyframes, expressions*, recipes, evaluation, geometry
packages/engine   WebGPU: compositor, effects, rasterizer, 3D (three.js), output stage, readback
packages/media    Node: FFmpeg presets/encode/probe/verify; later decode, audio mix, image sequences
packages/vision*  Python sidecar (uv venv): OpenCV, SAM 2, ProPainter/LaMa, Depth Anything, pycolmap, PyOpenColorIO, OpenEXR
packages/ai*      MCP server exposing the operation registry; Claude Code / Codex CLI adapters
packages/show*    live show runtime: cue list, output windows, Spout/NDI/MIDI/OSC
apps/studio       Electron app: main (files, sidecars, windows), preload (bridge), renderer (React UI + engine)
tools/register    capability-register validation and reports
```

Packages marked * are later milestones. Each concern in brief §20 maps to one package or module:
- project/assets → core + media
- time/property evaluation → core
- compositing → engine
- 3D → engine + three.js
- simulation → engine + Rapier, with a checkpointed sim contract
- calibration/output → core geometry + engine output
- audio → media + core analysis
- render jobs → studio + engine
- encoders → media
- delivery → studio main
- live show → show

## 5. Conventions every module follows

### Time
- Integer **flicks** (1/705,600,000 s). Every common frame rate and sample rate divides evenly, so frame boundaries are exact.
- Evaluation is a pure function of the project snapshot and the time, with no clocks and no accumulated state.

### Randomness
- **Stateless hashing**, of the form `rand01(seed, keys…)` using PCG.
- Bit-identical in TypeScript (`core/rng.ts`) and WGSL (`engine/shaders.ts`); a unit test pins reference values.
- No `Math.random` in evaluation paths. The expression sandbox removes `Math.random` and `Date`.

### Colour and alpha
- **User-facing colours** are sRGB-encoded with straight alpha.
- **Working buffers** are `rgba16float`, scene-linear (Rec.709/sRGB primaries by default; an ACEScg working space comes with OCIO in milestone D), with **premultiplied** alpha.
- **Exceptions:** object-ID and Cryptomatte passes use exact 32-bit formats. Perceptual effects (curves, levels, hue) declare that they run on display-referred values and convert explicitly.
- **Output:** display encoding (sRGB/BT.709 tags) is applied at the final encode, once. The comp background is not baked into renders. Files with alpha get straight alpha from an explicit unpremultiply.

### Coordinate spaces
- **Composition:** pixels, origin top-left, +y down (AE).
- **Layer:** a layer's own pixels; masks and effects run here. Transform order is position · rotX · rotY · rotZ · scale · (−anchor).
- **Venue canvas:** pixels of the venue's reference. A venue-bound composition maps 1:1.
- **Physical 3D:** metres, right-handed, +y up.
- **Projector output:** pixels of that projector's raster.
- **Content (UV) vs projector coordinates** are distinct objects. Calibration maps content to output.

### Effect contract
Every effect declares:
- **bounds expansion**: the caller pads, so nothing clips
- **temporal reads**: which times it samples; frames are cached by (node, exact time) and clip ends are handled as transparent, hold, mirror or loop
- **colour-space expectation** and **precision**
- **determinism class**: pure / seeded / cached-from-sidecar

Effects never touch calibration warps, output masks or output colour.

### Stateful simulation contract (decided now, built in milestone D)
- `init(seed, params) → state₀`, `step(state, dt) → state`, `render(state, t)`.
- Checkpoints every N frames are stored in the cache, keyed by (sim id, params hash, frame).
- Seeking loads the nearest checkpoint at or before t and steps forward.
- Before a parallel or background render, a sequential bake fills the checkpoints, so render workers never skip history.
- Replay is bit-identical on the same GPU class. Other machines play baked caches.

### Venue, show, binding
- Venues hold physical geometry, regions, projectors and calibration (versioned and lockable).
- Shows reference regions by **role** (`{ role: "windows", index? }`).
- Bindings map roles to ordered region ids per venue. Rebinding a show to another venue means changing bindings, then regenerating recipes.

### Projector output pipeline
Each stage happens exactly once, and the export manifest records which stages are baked:

```
show content (venue canvas or 3D world)
  → creative masks/effects (inside compositions)
  → geometry mapping (homography / mesh warp, or venue model rendered from the calibrated projector camera with UV + audience-view projective texturing)
  → output masks (block light)
  → edge blend (multi-projector)
  → output colour correction (per projector)
  → display encoding → file / window / Spout / NDI
```

### Operations
- Every change goes through `History.apply()`. Arguments are validated with Zod; Immer patches give exact undo; drags are coalesced.
- **Recipes** are deterministic generators. Hand edits to generated layers are recorded as overrides and survive regeneration. The UI flags simple controls that no longer fully apply.

### Errors
User-facing errors carry a plain message naming the item, plus an action ("Unlock it to change it", "Install it with…"). Raw details sit in an expandable section.

## 6. AI assistant (subscription-based, no API keys)

```
Before Effects (renderer) ──IPC── main ── spawns ── `claude -p …` or `codex exec …` (user's logged-in CLI)
                                      │                     │
                                      └── local MCP server ◄┘ (stdio; started by the CLI from --mcp-config)
                                           tools: project_summary, selection, list_regions, list_recipes,
                                                  propose_ops (validated, preview only), render_still, explain
```

- The MCP server connects back to the running app over a local named pipe with a per-session token.
- **Preview first.** `propose_ops` creates a reversible preview transaction. The user accepts, or the app auto-accepts when that setting is on. The result is one undo step labelled "Assistant: …".
- **Bounded edits.** The app rejects transactions that touch items outside the current selection or the items they create.
- **Honest failure.** Unsupported requests return a plain explanation, never a fake success. Success is claimed only after the project changed and a preview frame rendered.
- **Privacy.** The model receives project *structure* (names, regions, parameters), not media. `render_still` sends a downscaled frame only when the model asks to look, and the UI says so.
- **Without AI.** Every capability stays reachable without it.
- **To verify in the B6 increment:** exact CLI flags for headless MCP use with subscription auth: `claude -p --mcp-config --output-format stream-json --allowedTools`, `codex exec` plus MCP config. Also login detection, and rate-limit and plan-limit messaging.

## 7. Performance plan

- **Preview:**
  - render scale 1, ½ or ¼, disclosed in the UI ("Preview at half resolution")
  - frame cache keyed by (comp, time, evaluation hash)
  - background pre-render of heavy nested comps
- **Export:** runs in a hidden renderer process on an immutable project snapshot, so editing continues.
  - **Pipeline:** GPU readback ring buffers (async), then the main process, then FFmpeg stdin with backpressure.
  - **Resilience:** image sequences are resumable, with missing-frame detection.
- **Memory:** pooled textures with a VRAM budget; layer textures are capped at 8192 px with density fallback; device-lost recovery.

## 8. Dependencies that need installation, licences, models or equipment

| Need | For | Status / licence |
|---|---|---|
| FFmpeg 9 full build (gyan.dev) | All encode/decode, HAP, ProRes, DNxHR | **Installed** (winget). GPL, OK for personal use |
| Electron 44, three.js, React, Zod, Immer | App, 3D, UI, core | Installed. MIT |
| Claude Code CLI (user's Claude plan) / Codex CLI (user's ChatGPT plan) | AI assistant | **Both installed**; usage counts against the user's plan limits |
| Python 3.12+ via uv venv; OpenCV; PyTorch or onnxruntime (CUDA) | Tracking, calibration solve, roto, cleanup | uv installed; venv created in milestone D. Apache/BSD |
| SAM 2.1 weights (~0.2–0.9 GB) | Roto / object isolation | Apache-2.0 |
| ProPainter weights | Video object removal (content-aware fill) | **Non-commercial** (S-Lab); personal-use only. LaMa (Apache-2.0) is the fallback |
| Depth Anything V2 | Depth maps from photos/footage | Small: Apache-2.0; Base/Large: **CC-BY-NC** |
| PyOpenColorIO + ACES 2.0 configs, OpenEXR | Colour management, multi-layer EXR | BSD |
| Blender 4.x/5.x (optional, headless) | Camera solve fallback, cloth/fluid sims, Cycles hero renders | GPL; install on demand |
| Rapier (WASM) | Deterministic rigid-body fracture/collapse | Apache-2.0 |
| CanvasKit / HarfBuzz (WASM) | Path booleans and offsets, text shaping, variable fonts | BSD / MIT |
| Spout (Windows), NDI SDK/runtime | Live texture sharing | Spout BSD; NDI free with licence terms |
| Google Drive for desktop **or** your own Google Cloud OAuth client | Upload to Drive (synced-folder route first) | Free; the OAuth client is created in your Google account |
| **Equipment** | Projector(s) and HDMI/DP output; a camera (webcam or DSLR) for camera-assisted alignment; tape or laser distance meter for venue measurement; ideally a second monitor for show control | Not yet available; physical acceptance tests wait for it |
