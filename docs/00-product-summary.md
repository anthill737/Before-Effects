# Before Effects — product summary

**Before Effects** is a desktop studio for authoring, animating, previewing, rendering, exporting and playing **3D projection-mapping shows**. It brings the useful creative power of After Effects into a workflow built around physical buildings, rooms, stages and objects. It is also designed so a first-time user can make a compelling show without an After Effects course.

The source brief is [`brief.txt`](brief.txt). This page condenses it, and lists the decisions made at kickoff on 2026-10-01 and the assumptions still open.

## What it must do

- **Full creative scope.** It must cover every After Effects capability that is useful for projection mapping:
  - compositions, layers, nesting
  - keyframes and the graph editor
  - expressions and rigs
  - masks, mattes, blend modes
  - shapes, text, true 3D, multi-pass
  - the effect catalogue
  - tracking, roto, cleanup, puppet
  - audio-driven animation, colour management
  - rendering and delivery

  It must also cover what mapping tools add: surfaces, regions, projector calibration, output masks, edge blending, live playback and media-server formats. The traceable inventory lives in [`register/`](register/).
- **Staged, never reduced.** Work is delivered in milestones (A–F, see [`02-build-plan.md`](02-build-plan.md)). No milestone redefines the final scope.
- **Radically easier.** Ease of use is a release gate, equal to functional completeness:
  - A common result takes **select → choose an outcome → adjust 3–5 plain controls → see it**.
  - Underneath, the app builds the masks, paths, layers, keyframes, expressions, geometry and routing as ordinary editable objects.
  - A feature that works but still needs specialist knowledge for its common use has not met the requirement.

## The shape of the product

| Concept | What the user sees | What it is underneath |
|---|---|---|
| **Space** (venue) | "Set up the space": a photo or model of the building, named regions (windows, roofline, door…), one or more projectors | Physical installation geometry, regions, projectors, versioned calibration. Creative edits never move it. |
| **Show** | Scenes, effects, music, timeline | Compositions, layers, keyframes, effects, recipes. They target region *roles*, so a show can be rebound to another venue. |
| **Effect / recipe** | "Trace with light", "Light up one after another", "Turn into water"… | A deterministic generator that creates real, editable layers. Hand edits become tracked overrides and are never silently lost. |
| **Projector output** | "Files for my projector", or live output | The show rendered through each projector's calibration, output masks and output colour, applied exactly once. |
| **Assistant** | "Make these windows pulse blue with the music, then turn the wall into water" | The user's own Claude or ChatGPT subscription driving the same undoable operations as the visual UI. |

The primary route is **Set up the space → Add content → Animate → Preview → Export or Play**. People can move between steps freely, and can skip hardware setup entirely if they only want to design and export content.

## Kickoff decisions (user, 2026-10-01)

| Topic | Decision | Consequence |
|---|---|---|
| AI assistant | **No API keys.** Use the person's own Claude or ChatGPT subscription. | Adapters drive the locally installed, logged-in **Claude Code** (`claude -p`) and **OpenAI Codex CLI** (`codex exec`), which talk to Before Effects through a local MCP server. Both CLIs are installed on this machine. |
| Licensing | **Personal use only.** | GPL tools (FFmpeg full build, Blender) and non-commercial research models (e.g. ProPainter for object removal) are allowed. They stay behind optional integration boundaries in case that changes. |
| First hardware target | **One projector.** | Calibration and output for one projector come first (milestone B). Multi-projector blending stays in scope for milestone E. |
| Export vs live | Not answered. Defaulted to **export first, live later.** | Offline, frame-accurate rendering is the first priority; the live show workspace is milestone E. |

## Decisions update (user, 2026-10-02)

| Topic | Decision |
|---|---|
| After Effects projects | **Import required**, and editing must continue after import; a flattened video doesn't count. Two routes: an exporter script that runs inside After Effects (needs After Effects installed, highest fidelity), and a direct `.aep` reader (no After Effects; partial). Every import gets an explicit compatibility report, and the original file is never modified. |
| Fluid and smoke | **Real simulation required**, plus fast presets. In-app GPU solvers (grid smoke/ink, water surface, particle liquid) with deterministic checkpoint caches and a separate *Prepare simulation* step; optional offline 3D via Blender Mantaflow. |
| Audio | **Stereo sound required**: multiple tracks, waveforms, trims, fades, volume, pan, mix, export, beat-driven animation. The mixer is built on a bus model so multichannel output can come later. |
| Stereoscopic video | **Unconfirmed.** Recorded as a possible future capability; it must not complicate the build. |
| DMX, timecode | Stay in the full plan as optional integrations (milestone E). Hardware validation is recorded separately. |
| Launcher | A **double-click `Before Effects.exe`** in the project root plus a desktop shortcut. No terminal. It checks prerequisites, shows useful startup errors, handles a second launch, and cleans up background processes. |
| Preview | A large preview with **Show / 3D projection / Projector output** views, a pop-out window, full transport controls and audio sync. Resolution choices are **Auto / Full / Half / Quarter / Eighth / Custom**, defined by image dimensions and kept separate from display zoom; Full is never silently downgraded. Real-time and cache-first playback modes, with fps, dropped-frame and cache reporting. |
| Remaining questions | 19 of the 24 open register questions were resolved with reversible defaults (see the register). The 5 still open are optional future items that block nothing: stereoscopic rig, local AI model, other cloud services, Syphon (macOS), and multi-machine rendering. |

## Assumptions to confirm (they change sizing, not the architecture)

- Output resolution up to **4K per projector at up to 60 fps**. Shows up to about **20 minutes**.
- Rendering on this machine: RTX 5070 Ti Laptop (12 GB), Core Ultra 9 275HX, 32 GB RAM, Windows 11. Renders and caches default to **D:** (about 800 GB free).
- No projector or camera is available for testing yet. Physical calibration acceptance waits for real hardware; a canned example is never counted as proof (brief §0.10).

## What needs extra software, models, licences or equipment

Brief §23 requires this list. It is kept current in [`01-architecture.md`](01-architecture.md#dependencies-that-need-installation-licences-models-or-equipment).
