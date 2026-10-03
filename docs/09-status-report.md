# Before Effects: status report (2026-10-02)

> **Update (2026-10-03):** the four parts of the latest brief are in, in order.
> 1. **The external-agent API**, with 106 tools. Its acceptance run passes 14/14 on the packaged app.
> 2. **Automatic house setup**, moving architectural parts, and keyframes on ordinary layers.
> 3. **Blender integration.**
>    - Effects: smoke, fire, water, cloth reveal and break apart.
>    - Linked `.blend` files, kept editable through the editable 3D import.
>    - Rapier motion is transferred to Blender.
>    - Every setting is adjustable in the inspector.
>
>    Broader 3D effects:
>    - Particles: sparks, embers, snow and confetti.
>    - Explode and Crumble with Rapier.
>    - Melt.
>
>    Each effect is labelled physical or procedural.
> 4. **Several projectors:** edge blending, outputs that stay in step, blackout, and recovery when a display disconnects.
>
> Totals:
> - 261 unit tests pass.
> - The full journey (139 steps) passed apart from 4 keyframe steps, which failed only because an earlier step left the projector view open. That's fixed, and they pass in the re-run.
> - The recorded effects demo passes in the packaged app.
>
> Details:
> - [docs/12-blender.md](12-blender.md)
> - [docs/13-effects-and-settings.md](13-effects-and-settings.md): what is simulated, and what updates when
> - [docs/14-multiple-projectors.md](14-multiple-projectors.md)

> **Update (2026-10-02):** the scope is now projection-first. Building areas, content assigned to areas, scenes and the show, editable internal 3D with Rapier physics (collapse and rebuild), and timeline editing (bar lengths, collapse/rebuild markers, keyframes with easing) are in the app. Both acceptance workflows pass in the packaged app. Evidence, measurements and limits: [docs/10-projection-workflows.md](10-projection-workflows.md). Totals on the final code: **213 unit tests** and **99 journey steps** (development build) pass. The embedded AI assistant is deferred.

## Start it

- **Double-click `Before Effects.exe` in the repository folder** (build it once with `tools\launcher\build.cmd`), or use the **Before Effects** shortcut it creates on the desktop.
- No terminal is needed. The launcher:
  - works from any starting folder
  - rebuilds automatically when the sources changed
  - checks prerequisites and explains how to fix any that are missing
  - shows the log tail if starting fails
  - brings an already-running copy to the front
  - stops every background process when the app closes
- To try your own content, put a building photo, a video, music and an After Effects project in `<data folder>\Test content`.

## Implemented and tested

"Tested" means automated journey tests that drive the real UI, plus a visual review of their screenshots. Exceptions are marked.

| Area | What works | Evidence |
|---|---|---|
| Launcher | Double-click start, any folder, single instance, clean shutdown, failure dialog with log | Final check on the packaged build: window up 0.7 s after starting from another folder; a second start exits (code 0) without a duplicate; closing leaves 0 processes |
| Live preview | Show / 3D projection / Projector output views; enlarge, pop-out window; play/pause/restart, frame stepping, scrubbing, loop and range; overlays; audio in sync (0 ms) | Journey steps `find-preview` … `projector-output-window`, `audio-preview-sync` |
| Preview resolution | Auto, Full, Half, Quarter, Eighth, Custom by image size (e.g. 1920×1080 → 960×540 → 480×270 → 240×135). Resolution is separate from zoom; Auto shows its effective setting and renders full when paused. Effect quality, real-time vs cache-first, fps, dropped frames, cache progress. Only affected frames are invalidated | `resolution-*`, `zoom-is-display-only`, `cache-first-playback` (30/30 fps), `edit-invalidates-only-affected` |
| Preview caching and preparation | Cache amounts recommended from the hardware (graphics card and its memory, the computer's memory, free space on the frames' drive), with reasons and one click to use them; every amount stays adjustable. "Prepare this scene" / "Prepare the whole show": simulations first, then every frame rendered once at a preview size and kept on disk; it resumes after a pause, an edit or a restart, refuses up front (saying what to change) when the disk cache can't hold every frame, stops when the drive is nearly full, and checks every frame at the end. An edit inside a scene re-prepares only where the show plays that part. Prepared frames on disk play at full frame rate with little graphics memory, and show on the timeline. Agent API: `preview.recommend`, `prepare.frames`, `prepare.status`, `prepare.stop`, `prepare.wait` | Test copy, 2026-10-03: a 40 s three-scene show prepared at Full in 32 s (1,170 frames); an edit in the last scene re-rendered 121 frames; it played from disk at 30/30 fps with 1.5 GB of graphics memory; after a restart nothing was rendered again. A 20-minute show with many 3D scenes and videos prepares at 6.4 frames/s at Full (9 at Quarter) (about 90 minutes, the same as exporting it; its 3D shadow maps cost a fixed ~115 ms of GPU time per frame); memory stayed flat over 6 minutes | 
| Your own building | Photo import; trace, name and group surfaces; find similar windows; correct outlines; keep-light-off areas; save, close and reopen | `photo-*`, `trace-*`, `find-similar-windows`, `save-close-reopen` |
| Your own content | Images, video (proxies in preview, originals in export), text, music; stereo sound with volume, pan and fades; beat detection (119.9 BPM on a 120 BPM track); "Move with the beat" | `import-media` … `av-timing-measured` (A/V offset mean 1 ms, worst 1 frame) |
| Effects | Trace with light, Light up one after another, Pulse, Neon outline, Fill with colour, Show a picture or video, Add text, Move with the beat, **Smoke rising**, **Fill with flowing water**, **Crack and rebuild** | Journey steps; screenshots reviewed |
| Simulations | GPU smoke and FLIP water, prepared in the background with checkpoints; byte-identical reruns; re-prepares after edits; export uses the same frames | `sim-*`, docs/07 |
| Projector output | Full-screen on a chosen display; numbered test patterns; alignment points; output masks; keep-light-off; output size independent of preview | `projector-output-window`, `projector-respects-keep-off` (single built-in display only) |
| Background rendering | Snapshot jobs; edit while rendering (export matched its snapshot: 0.02 average difference); progress, cancel, retry; disk-space check; history; explicit export size (Full/Half/Quarter) and range; verified files | `export-run`, `render-while-editing`, `cancel-and-retry`, `export-half-range` |
| Export | "What is the file for?": share (MP4), master (ProRes 422 HQ), transparent (ProRes 4444), projector (MP4 or HAP). A Quarter-size preview never causes a Quarter export | `export-run` (1920×1080 after previewing at Quarter) |
| AI assistant | Uses your own Claude (Claude Code) or ChatGPT (Codex) subscription, never an API key. Plain-language requests become editable effects; "What changed"; one undo step per request; selective undo keeps later work; follow-ups ("slower", "only these windows"); Stop; plain errors; setup guidance | `assistant-*`; **live**: Claude Code and Codex, each on a personal subscription, made, slowed and retargeted a blue music-driven effect (docs/05) |
| After Effects import | Opens `.aep` directly (no After Effects needed) or the exporter script's JSON. Compatibility report; media found next to the project or with **Find missing files…** (searches a folder tree by name); original kept | Reader: 603/603 sample projects; importer on AE 2018–2026 exports; `ae-*` steps incl. relinking 2 of 3 files from a folder tree (docs/06) |
| Robustness | Autosave and crash recovery; plain-language errors; a failed Drive copy can be retried without re-rendering; logging can't loop or fill the disk | `drive-upload-retry`; log fixes |

Final run on 2026-10-02: **199 unit tests pass** and **all 71 journey steps pass** (`npx electron . --ui-test` from `apps/studio`). Live checks against your real Claude and ChatGPT subscriptions are opt-in (`BE_UITEST_LIVE_AI=claude,codex`); they passed earlier today, including in the packaged app.

## Prototype or partial (works, but not complete)

- **Google Drive delivery:** copies into the Drive for desktop folder. **Drive for desktop isn't installed on this PC**, so only failure and retry were tested, against a stand-in folder.
- **After Effects exporter script:** proven against a simulated After Effects scripting model built from a real export. **Not yet run inside After Effects**, which isn't installed here.
- **After Effects content Before Effects can't render yet:**
  - Kept but not rendered: effects other than Blur and Glow, expressions, 3D cameras and lights.
  - Not imported: time remapping, text animators, layer styles, shape operators such as Repeater.
  - Each one is listed in the report.
- **Smoke and water simulations are 2D**, in the composition's plane. Rigid-body 3D (collapse and rebuild) is real 3D: see docs/10.
- **Assistant edits apply live with undo.** There's no separate "proposal" mode, and edits are kept to what was asked by the tool design rather than a hard lock.

## Needs hardware testing

- A real projector on a second output: full-screen placement, alignment accuracy, keep-light-off on the building, HAP playback in a media server.
- Two or more real projectors: physical overlap and blend quality, black-level matching, and reconnecting a display (written, but untested without unplugging one).
- GPU portability: tested only on this PC's GPU. Simulation reproducibility is per machine and driver.
- Google Drive for desktop: install and sign in, then send an export.

## Needs people

- **First-time user sessions:** the kit is ready (docs/08) with 13 tasks using the participant's own photo, media and music, and a pass bar. **No sessions have been run yet.**

## Decisions and open questions

- Settled with you: one projector first; AI on your own subscription with no API keys; personal use only; After Effects import, real fluid/smoke and stereo audio are required; DMX and timecode stay in the plan.
- **Still open:** stereoscopic video (unconfirmed). Your call when it matters.
- **If the app is ever shared beyond personal use:**
  - Driving your Claude subscription through Claude Code is fine for your own use. Distributing it needs Anthropic's approval, or an explicit, clearly billed API-key option.
  - For ChatGPT, OpenAI's "Sign in with ChatGPT" for apps is the sanctioned route.

## Verification against the brief's list

| Brief item | Result |
|---|---|
| Double-click launch | ✅ |
| Own content | ✅ photo, video, picture, text, music |
| Save, close and reopen | ✅ |
| Interactive preview and frame stepping | ✅ |
| Full, Half, Quarter, Eighth, Auto | ✅ exact sizes; Auto labelled |
| Consistency across scales | ✅ the same frame at Full (averaged down) and Half differs by 0.08/255 on average (`scales-consistent`); exports ignore the preview size |
| Full-quality export after a reduced preview | ✅ |
| Real files and audio timing | ✅ ffprobe-verified files; A/V offset 1 ms mean |
| Background rendering while editing | ✅ |
| Recovery from failures | ✅ cancel and retry; Drive copy retry; plain errors; autosave recovery |
