# House setup, moving parts and external agents (2026-10-02)

This covers the first two items of the consolidated brief:
1. Access for external agents (Claude Code, Codex, any MCP client).
2. The house as the standard demonstration: photo import (HEIC included), automatic house setup, moving architectural parts, and keyframes on ordinary layers.

## External agents

Before Effects runs a local API whenever it's open, if **Agents → Allow agents** is on. The API is reachable only from this computer (127.0.0.1). Calls need an access key, which the app keeps in `%APPDATA%\Before Effects\agent-api.json`. Browsers and other machines are refused.

**Connecting:** the Agents panel shows exact, copyable setup for Claude Code, Codex, other MCP clients and the command line. For example, for Claude Code:

```
claude mcp add before-effects -e ELECTRON_RUN_AS_NODE=1 -- "<Before Effects.exe>" "<…>\resources\app.asar.unpacked\out\main\agent-mcp.js"
```

Agents use the same methods the app does:
- **Inspection:** `project.get`, `areas.list`, `content.list`, `scenes.list`, …
- **Areas and content:** `areas.create`, `areas.split`, `areas.merge`, `content.assign`, …
- **House setup:** `house.detect`, `house.proposals`, `house.accept`, `house.discard`
- **Moving parts:** `parts.animate`, `parts.list`, `parts.remove`
- **3D, keyframes, playback, preview capture, save and export:** see `api.capabilities` for the full list with schemas.

Every changing call is one undo step, labelled "Agent: …", and applies completely or not at all. A call can carry `expectRevision`, so it's refused if the show changed in between. Reusing a `requestId` returns the first result, which makes retries safe. Progress and changes arrive as events (`GET /v1/events`, resumable).

Runnable examples are in `tools/agent-examples/`:
- `quickstart.ps1`
- `mcp-client.mjs`
- `acceptance.mjs`: the full acceptance run with a separately launched client and simulated manual edits
- `house-demo.mjs`: the recorded house workflow

## The building photo

- **New show from a photo:** use the welcome screen, or drop a photo on the window. JPEG, PNG and HEIC/HEIF photos are accepted.
- **HEIC/HEIF** is decoded on this computer: libheif (WebAssembly) handles orientation, crop, tiles and transparency, with the bundled FFmpeg as a fallback. HDR is tone-mapped to SDR. The original file is kept; the app works from a decoded PNG next to it. If a file can't be decoded, the message says what to do (for example, export it as JPEG). Two of the libheif conformance files (an unusual crop window and padding) don't decode; HDR HEIC is untested for lack of a sample.
- **Canvas:** the show is 1920×1080. The photo is fitted without stretching. **Photo in the frame** sets fit/fill, size, position and per-edge crop. Traced areas don't move when the photo is re-placed, because they are the mapping.
- **Views:**
  - **On the house** simulates the show lit onto the photo.
  - **Show preview** shows only projected light.

  The photo itself is never exported or sent to the projector.

## Automatic house setup

**Find areas automatically** (Areas panel, or `house.detect`) looks for the house's parts and proposes them as areas.

**Models:** two open models, downloaded once from Hugging Face after you agree (235 MB, Apache-2.0), into `<data folder>\Models\hf-cache`:
- Grounding DINO tiny (quantized) finds parts by name.
- SlimSAM traces outlines.

They run through ONNX Runtime in a separate process: on the GPU (DirectML) when possible, otherwise on the CPU. Typical times are about 10 s on the GPU and about 20 s on the CPU. The photo never leaves the computer. Progress shows in the panel, and **Cancel** stops the run. A crash in the GPU driver can't take the editor down.

**What it proposes:**
- windows, doors, garage doors, columns and brick pillars, vents and light fixtures;
- the roofline;
- the facade, with its openings cut out (the cut follows them if you reshape them).

The porch and steps join the facade. Dark roof shingles are left out, since projected light barely shows on them. Parts that aren't on this house (a neighbour's light) are dropped.

**How outlines are drawn.** The rules are general, not tuned to one house:
- Doors, garage doors, windows, columns and vents are fitted as rectangles seen at the house's angle. The vertical and horizontal vanishing points are estimated, by consensus, from the edges the photo shows clearly. Each side follows its perspective direction (turning slightly where lenses bend lines) and is found as one whole line in the photo, so a shadow across a door can't bend it.
- An edge must separate two bands of colour. Solid parts are matched by their own colour, allowing for shade on coloured materials such as brick; windows are edged by where the surrounding wall stops.
- The traced shape is a second opinion.
- Searches stay mostly inside the detector's box, because those boxes enclose parts rather than cut them.
- The facade's bottom follows the lowest course of the wall in straight runs, with notches closed only where wall is on both sides.
- The roofline is straight runs carried on to the eave tips.

**Review.** Proposals are dashed; amber ones carry a reason to check them (low confidence, may be a decoration, may not be part of this house). From there you can:
- select a proposal, drag its corners and change its kind;
- split an area (side by side or stacked) or join several;
- remove or accept each one, or **Accept all**.

Accepting binds areas to their kind's role, so effects for "all windows" use them, and groups them as Windows, Openings and Lights. Each action is one undo step. Nothing proposed is used by effects until it's accepted.

**Measured on the standard house photo:** after refinement, the corners of the seven rectangular parts are on average 4 px from corners marked by hand (worst 14 px).

## Moving parts (3D)

Select a door, garage door, window or other area. Then use **Make it move (3D)** in the inspector, or the quick action beside the selection. The motions are:
- **Swing open** on a hinge, into the house or toward the audience;
- **Raise**: slide up behind the wall, or tip up and back;
- **Push in**, **Slide away**, **Turn around**;
- **Fall off**, with physics prepared ahead of time like collapses.

Each scene gets one **House parts (3D)** layer at the bottom of its stack, so content on areas draws over it. It holds:
- the facade as a solid with the photo on its front and its openings cut out, so no copy of a moved part stays behind;
- still copies of openings that don't move;
- each moving part, as a photo-faced solid turning about its hinge;
- something behind every moving part's opening: a dark recess, a lit room, a picture, or the wall's own colour.

The layer is clipped to the house outline by default; the panel shows that clipping boundary separately from each part's source area.

Motions are ordinary keyframes. The 3D panel's **How it moves** section edits the motion, hinge, angle, timing and what's behind. Depths are assumed, not measured, and are labelled so: facade 25 cm, doors 6 cm, garage door 8 cm. Traced areas are never changed. Agents use `parts.animate`.

## Keyframes on ordinary layers

- ◆ beside opacity, size, position, turn, text size and text colour adds or removes a keyframe at the playhead. Once a value is animated, changing it adds a keyframe there. Times are the layer's own, so moving the layer moves its animation.
- Diamonds on the layer's bar can be dragged to retime them. Clicking one offers easing (smooth, steady, start slowly, arrive slowly, jump), then **Custom curve…**, which has a picture of the curve and "slow leaving"/"slow arriving" sliders. The same menu now serves 3D objects.

## Verification

- `pnpm test`: 241 unit tests, including synthetic tests of the house-fitting rules.
- **Journey steps** (`BE_UITEST_ONLY=…`, from `apps/studio`):
  - `heic-*`: rotated HEIC, transparency, thumbnails, preview, save/reopen, export.
  - `house-*`: detect → correct an outline → remove a doubtful one → split/join → accept → undo/redo → door and window moving → video on the garage door → save/reopen → export, with the traced areas checked unchanged throughout.
  - `keys-*`
- **Packaged app:**
  - `node tools/agent-examples/house-demo.mjs` records the house workflow, driven by real mouse and keyboard input.
  - `node tools/agent-examples/acceptance.mjs` runs the agent acceptance (14 checks).

## Limitations

- Detection quality depends on the photo. The proposals are a starting point to review, not a survey.
- Roof surfaces are proposed only when traced cleanly. Dark ones are deliberately left out.
- Depths in 3D are assumed.
- HEIC: see above.
