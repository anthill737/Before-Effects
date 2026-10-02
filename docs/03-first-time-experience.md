# First-time experience and the common creative task

This is the intended experience, and it is being prototyped in the real app (`apps/studio`) rather than as throwaway mockups. It is validated with first-time users (brief §0.10). The targets are design goals, not measured claims.

## 1. First launch (0–60 s)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Before Effects                                                              │
│                                                                              │
│   What would you like to make?                                               │
│                                                                              │
│   ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐ ┌─────────┐ │
│   │ ▶ Try the sample │ │ 📷 My building    │ │ ⬚ 3D model of    │ │ Just    │ │
│   │   town hall      │ │   from a photo   │ │   my venue       │ │ content │ │
│   │ (opens playing)  │ │                  │ │                  │ │         │ │
│   └──────────────────┘ └──────────────────┘ └──────────────────┘ └─────────┘ │
│   Recent shows ·  Recover unsaved work (if any)                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Try the sample** opens the town hall immediately, already playing a short show.
- **My building from a photo** asks for one thing: a straight-on photo. It explains: *"We'll use the photo to trace windows and edges. It isn't a 3D measurement — you'll line things up with the projector later."*
- Each path explains only what it needs. There is no account and no setup wizard to finish before anything happens.

## 2. The studio (always the same layout)

```
┌ Space ─ Content ─ Animate ─ Preview ─ Export/Play ───────────── ⟲ ⟳  Saved ✓ ┐
├──────────────┬─────────────────────────────────────────────┬──────────────────┤
│ Effects      │                                             │ Inspector        │
│ library      │            CANVAS (central, large)          │ (only what the   │
│ 🔎 "water"   │   click a window, roofline, door, wall…     │  selection needs)│
│ Light ▸      │   hover = highlight, click = select,        │                  │
│ Water ▸      │   shift-click = add, "select all similar"   │ Color  ███       │
│ Cracks ▸     │                                             │ Speed  ──●──     │
│ …            │   [ Content | On the building | Projector ] │ Glow   ───●─     │
│              │                                             │ More controls ▾  │
├──────────────┴─────────────────────────────────────────────┴──────────────────┤
│ ▶ 00:04.2  timeline: one bar per effect, drag to move, edges to trim          │
└───────────────────────────────────────────────────────────────────────────────┘
```

- **Canvas first.** Selecting physical regions and creative objects happens directly in the picture. Panels can be collapsed and the canvas or timeline enlarged.
- **Outcome-first action bar.** When something is selected, a small bar appears next to it with the 3–6 most suitable outcomes for that kind of region, e.g. for a window: *Light up · Trace with light · Pulse · Fill with color · Reveal*. Search sits at the end of the bar.
- **The inspector shows 3–5 controls.** Then "More controls" (every recipe parameter) and "Edit animation" (the generated layers, keyframes and effects in the detailed timeline). Both edit the same project.
- **Always safe.**
  - Undo/redo with the action named ("Undo Trace with light").
  - Autosave every few seconds, with a visible *Saved* state.
  - Recovery on the next launch after a crash.
  - Hover previews are reversible and change nothing until clicked.

## 3. The common creative task — "Trace the roofline with light"

| Step | Person does | App does |
|---|---|---|
| 1 | Clicks the roofline | Highlights it; the action bar offers *Trace with light* first (edges suit it) |
| 2 | Clicks **Trace with light** | Applies the recipe: a shape layer bound to the roofline's region (not a copy of its outline), trim-path animation, glow, timing scaled to the path length and scene size. Starts playing. |
| 3 | (optional) Drags **Color**, **Time per lap**, **Glow**, **Light length** | Regenerates instantly. Hand edits made later in "Edit animation" survive. Controls they affect show *Customized* with a reset link. |

That is **two deliberate actions** to a playing result, within the ≤ 3-action target (§0.10). Nothing in the workflow mentions masks, trim paths, keyframes, expressions, codecs, UVs or premultiplication.

**Second task, "Light up the windows one after another":**
1. Click any window. A suggestion chip offers *Select all 9 windows*.
2. Click the chip, then **Light up one after another**.
3. Adjust order (left→right, top→bottom, from the center, random), delay and fade.

Underneath, this is one rig layer with per-window timing derived from each window's position. It is not nine hand-built layers.

## 4. Export as an outcome

*Export* asks **what the file is for**:

| Choice | Default preset | Notes |
|---|---|---|
| A video to share | MP4 (H.264), comp size | Plays everywhere |
| A high-quality master | ProRes 422 HQ | For editing / archiving |
| A transparent animation | ProRes 4444 (or PNG sequence) | Keeps alpha |
| Files for my projector | Calibrated projector output; HAP Q for media servers, or MP4 | Mapping and output correction baked **once**; manifest included |

- **Before rendering** it shows the destination folder, an estimated size and time once a few frames are measured, and whether sound is included.
- **Progress** is reported in plain phases: *Rendering frames → Encoding → Checking the file*.
- **When it finishes** it shows the verification result and a *Show in folder* button.
- **Codecs, pixel formats and colour transforms** sit under *Advanced*.

## 5. Usability targets (to measure, not claims)

- Create and preview an animated effect on a surface within **5 minutes**, from the sample, with no instructions.
- Assemble a three-scene show with music and start a compatible export within **20 minutes**, with waiting time measured separately.
- Apply a common effect to an existing selection in **≤ 3 deliberate actions**.
- Undo a mistaken change, and find the exported file, unaided.
- Each session records:
  - completion rate and time
  - confusion points
  - help requests
  - recovery from mistakes

Physical calibration is tested separately, with a real projector on a real surface.
