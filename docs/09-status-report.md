# Before Effects: status report (2026-10-02)

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
