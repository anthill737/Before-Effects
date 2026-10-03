# Controlling Before Effects from an external agent

Before Effects can be driven by an AI agent or a script running on the same PC while you keep
working in the editor. Agent edits use the same operations as the UI, appear immediately, and
can be undone like your own.

## 1. Turn it on

In Before Effects, click **Agents** in the top bar and switch **Allow agent access** on.
- It then starts every time Before Effects starts, including from the double-click launcher.
- It listens on `http://127.0.0.1:47821`, which is this PC only. You can change the port in the same panel.
- Agents read the URL and an access key from `%APPDATA%\Before Effects\agent-api.json`. Only your Windows account can read that file.
- **New access key** disconnects every agent.
- Switching access off stops it immediately.

The panel shows the exact setup commands for your installation, with copy buttons. They look like this for a packaged build:

**Claude Code**
```
claude mcp add before-effects -e ELECTRON_RUN_AS_NODE=1 -- "C:\…\build\app\Before Effects.exe" "C:\…\build\app\resources\app.asar.unpacked\out\main\agent-mcp.js"
```

**Codex**
```
codex mcp add before-effects --env ELECTRON_RUN_AS_NODE=1 -- "C:\…\Before Effects.exe" "C:\…\agent-mcp.js"
```

**Any other MCP client** (stdio server):
```json
{ "mcpServers": { "before-effects": { "command": "C:\\…\\Before Effects.exe", "args": ["C:\\…\\agent-mcp.js"], "env": { "ELECTRON_RUN_AS_NODE": "1" } } } }
```

**Command line** (Command Prompt):
```
set ELECTRON_RUN_AS_NODE=1
"C:\…\Before Effects.exe" "C:\…\agent-cli.js" status
"C:\…\Before Effects.exe" "C:\…\agent-cli.js" methods areas
"C:\…\Before Effects.exe" "C:\…\agent-cli.js" call areas.create "{\"kind\":\"window\",\"rect\":{\"x\":1316,\"y\":460,\"w\":292,\"h\":218}}"
"C:\…\Before Effects.exe" "C:\…\agent-cli.js" events
```
- For parameters that contain Windows paths, use forward slashes (`D:/Media/clip.mp4`) or pass a file: `call assets.import @params.json`.
- No separate Node install is needed: Before Effects' own executable runs the adapter.

**HTTP** (any language):
```
POST http://127.0.0.1:47821/v1/call
Authorization: Bearer <token from agent-api.json>
{ "method": "project.get", "params": {}, "requestId": "a-unique-id" }
```
- `GET /v1/capabilities` returns every method with its JSON Schema.
- `GET /v1/events` is a Server-Sent Events stream. To resume after a disconnect, send `Last-Event-ID` or `?after=N`.
- `POST /v1/events/poll` takes `{ after, timeoutMs }` for clients that can't stream.
- `quickstart.ps1` shows the same calls from PowerShell.

## 2. What an agent can do

Methods are grouped by name. MCP tool names use `_` instead of `.`, so `project.get` becomes `project_get`.

| Group | Methods |
|---|---|
| Show | `project.get`, `.save`, `.open`, `.newFromPhoto`; `history.undo`, `.redo`, `.list`, `.changes`; `selection.get`, `.set` |
| Building areas (shared by every scene) | `areas.list`, `.create`, `.update` (shape, holes, soft edge, grow/shrink, name, kind), `.delete`; `groups.set`, `.delete` |
| Media and content (per scene) | `assets.list`, `.import`; `content.assign` (repeat `each` or span `across`), `.update` (fit, crop, position, scale, rotation, trim, speed, loop, fades, opacity, blend, soft edge, volume), `.replace`, `.copyTo`, `.list` |
| Effects | `effects.catalog`, `.apply`, `.update`, `.remove` |
| Scenes and show | `scenes.list`, `.open`, `.duplicate`, `.create`, `.update`, `.delete`; `show.get`, `.set` (order, lengths, cuts and crossfades) |
| Layers and keyframes | `layers.list`, `.update`; `keyframes.set` (with easing), `.list`, `.remove` |
| 3D and physics | `scene3d.list`, `.get`, `.createFromAreas` (thickness, collapse and rebuild), `.update` (gravity, camera), `.objectAdd`, `.objectUpdate` (transform, material, physics, fracture, light), `.objectKeyframe`, `.objectRemove`, `.layer` (timing, contain or extend) |
| Preparation | `prepare.status`, `prepare.wait` (simulations and physics) |
| Preview | `playback.get`, `.set`; `preview.get`, `.set` (view, resolution, quality, orbit); `preview.capture` (a PNG of the real frame; `inline` also returns it as an image) |
| Export | `export.start` (share, master, transparent, projector; full, half or quarter size; range); `jobs.list`, `.get`, `.wait`, `.cancel`, `.retry` |
| Low level | `ops.list`, `ops.apply` (the same operations the UI uses); `transaction` (several calls as one undo step, all or nothing) |

## 3. Safety rules every call follows

- **One undo step per call**, marked as the agent's. Your Undo undoes it like anything else.
- **All or nothing.** A call or `transaction` that fails changes nothing.
- **Safe retries.** Send a `requestId`. Repeating it returns the first result instead of applying the change twice. The MCP adapter and CLI do this for you.
- **Conflict checks.** Pass `expectRevision` from your last read. If anything changed since then, including your own hand edits, the call is refused with `conflict` and lists what changed.
- **Clear errors.** Codes are `invalid_params`, `unknown_method`, `not_found`, `conflict`, `rejected`, `no_project`, `unsaved_changes`, `timeout` and `unavailable`, each with a plain message.
- **Exports render from a frozen copy**, so you and the agent can keep editing while they run.

## 4. Runnable examples

- `quickstart.ps1`: inspect the show and capture the preview from PowerShell.
- `mcp-client.mjs`: a tiny MCP client, the same protocol Claude Code and Codex use.
- `acceptance.mjs`: the full acceptance run against the packaged app.
  - Connect, inspect, create an area and assign media.
  - Change a 3D collapse and its timing, capture the preview, undo, save and export.
  - Monitor the export while hand edits are made, with a screen recording.
  - Check retries, conflicts, all-or-nothing transactions, a reconnected adapter and event stream, and an app restart.
  - Run it with `node tools/agent-examples/acceptance.mjs`. Results go to `<data folder>\Renders\agent-acceptance`.
- `full-demo.mjs`: a recorded tour of the whole app, used by hand the way a person would, ending with the full show played on the house.
  - It covers house setup, your own areas, media, light effects, moving parts, Blender simulations, Rapier physics, particles, an agent edit, two blended projectors, export and the show.
  - Long waits are fast-forwarded and labelled on screen.
  - Run it with `node tools/agent-examples/full-demo.mjs [photo]`. Without a photo argument it uses the first one in `<data folder>\Venue`.
  - The recording, the exported show and `report.json` go to `<data folder>\Renders\full-demo` and `<data folder>\Renders`.
  - `effects-demo.mjs` and `house-demo.mjs` are shorter recorded tours.
