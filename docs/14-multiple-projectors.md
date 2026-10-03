# Several projectors and edge blending

_Status 2026-10-02._

## What the person does

Open **Projector output** in the preview. The inspector's **Projectors** section then offers:
- **The projector list.** Click one to align it and see its output in the preview. **+ Add projector** adds another.
- **Share the picture.** Choose an overlap (default 15%), then **Side by side** or **One above the other**. This gives every projector a starting alignment: an equal slice of the picture, sharing that overlap with its neighbour. Then drag each projector's numbered points onto the building, as with one projector.
- **Edge blending.** On by default. Where projectors overlap, each gives a share of the light, so the overlap isn't brighter than the rest. **Blend curve** shapes the cross-fade:
  - 1 is straight;
  - 2 is smooth (the default);
  - 3 is softer still.
  A note says how much of the picture is lit, and how much by more than one projector.
- **Per projector:**
  - name and output size (its native resolution);
  - remove;
  - **output correction:** brightness, red/green/blue balance, gamma and black level, to match projectors to each other. These are never part of the show's look.

**Show on the projector** opens a full-screen output for the chosen projector on the display it's connected to. Open one per projector, each on its own display. Each projector remembers its display, which is saved with the project. Two buttons work on every output at once:
- **Open every projector's output** opens each on its remembered display.
- **Blackout all** turns every output black, and **Show all again** brings them back.

Each output reports the frame it is showing and its drawing rate, shown under its controls ("Showing frame 123 · 60 frames/s"). That makes stalled or out-of-step outputs visible.

If a projector's display is unplugged, its output waits, says so, and reopens on that display as soon as it is connected again. The display is matched by id, or by name and size, since Windows may renumber it. **Export → For the projector** can export the projector you're aligning, any other one, or **every projector** (one file each). Each file includes that projector's alignment and blend.

## How blending works

`packages/core/src/projection.ts`; the engine's `OUTPUT_WARP` shader mirrors it.

For each pixel of a projector's output, the warp finds the content point it shows. That point is then mapped into every other projector, through their alignments, to find which other projectors light it.

Each projector's weight there is how far the point lies inside its own frame (`edgeDistance`), shaped by the curve and divided by the sum over all projectors lighting it.
- `edgeDistance` is the distance to the nearer side multiplied by the distance to the nearer top or bottom, each as a fraction of the frame.
- The weights always add up to 1.
- The blend zone is exactly the real overlap, whatever its shape. No blend width needs setting.
- Outside overlaps the weight is 1.

The weight scales linear light, before output correction and display encoding. A projector decodes its signal back to light, so the light from overlapping projectors adds up evenly. Measured on the house with two 1920×1080 projectors side by side: across the overlap, the left and right outputs summed to 0.195–0.198 in linear light, against 0.195 where one projector is alone.

The arrangement maps each slice onto its projector's whole frame, because a projector lights all of its frame. It's a template; physical alignment comes from dragging the points.

## Agent API

| Method | Does |
|---|---|
| `projectors.list` | projectors, the current one, blending, and how much of the picture they cover and share |
| `projectors.add` | `{name?, width?, height?}` |
| `projectors.update` | `{projector, name?, width?, height?, gamma?, gain?, blackLevel?}` |
| `projectors.remove` | `{projector}` |
| `projectors.arrange` | `{layout: side-by-side or stacked, overlapPercent?}` |
| `projectors.align` | `{projector, points: [{content, output}] (≥4)}` |
| `projectors.blend` | `{enabled?, curve?}` |
| `projectors.select` | `{projector}`: which one previews and exports use |
| `displays.list` | connected displays |
| `outputs.list` | open outputs with what each is showing (frame, rate), and outputs waiting for a disconnected display |
| `outputs.open` | `{projector, display?, pattern?}`: remembers the display |
| `outputs.close` | `{projector?}`: one or all |
| `outputs.pattern` | `{projector?, pattern}`: `black` on all is blackout, `none` is back to the show |

`preview.capture` and `export.start` take `projector` too.

## Verified

- **Unit tests:** weights add to 1 in overlaps and fade across them; the curve; arrangement; undo of projector changes.
- **Journey steps:**
  - `proj-add`, `proj-arrange` and `proj-blend` measure each output's fade, and check it stays flat with blending off;
  - `proj-outputs-sync` opens both outputs, plays, and compares the frames each reports with each other and with the editor; then blackout and close.
  - `proj-export-all` exports one file per projector and checks the edges in each file.
- **Display disconnection:** the reopening logic is written but untested, since that needs a display to unplug.

## Limitations

- At most 8 projectors blend together.
- Blending doesn't yet account for other projectors' output masks. A projector masked off part of an overlap still counts as lighting it, so that part comes out darker. Avoid masking inside overlaps.
- There's no black-level matching for overlaps. A projector's black isn't zero, so overlaps look slightly lighter in dark scenes. **Black level** on the projectors outside the overlap can lift theirs to match, but by hand.
- Camera-based (automatic) alignment isn't built; alignment is by dragging points.
- Real-projector testing is pending. Everything above was measured on rendered outputs.
