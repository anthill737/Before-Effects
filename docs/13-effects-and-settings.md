# Effects: what's simulated, and what updates when

_Status 2026-10-02._

Every animation made in Before Effects has all its settings in the inspector, and every animatable value has ◆ for keyframes. Effects simulated in Blender work differently: their settings apply when Blender simulates again.

## Which engine does what

| Effect | Engine | Kind | Comes back as |
|---|---|---|---|
| Collapse & rebuild (3D), Explode (3D), Crumble (3D), "Fall off" parts | Before Effects, Rapier rigid bodies | physical | a live 3D layer; motion prepared in the background and cached |
| Break apart (Blender) | Blender, Bullet rigid bodies | physical | a video with transparency (the .blend stays editable) |
| Smoke rising, Fill with flowing water | Before Effects, 2D GPU solvers | physical (2D) | prepared frames, drawn live |
| Smoke, Fire, Water pouring, Cloth reveal (Blender) | Blender (Mantaflow, cloth) | physical (3D) | a video with transparency |
| Sparks, Embers, Snow, Confetti (3D) | Before Effects | procedural: placed by rule | a live 3D layer |
| Melt | Before Effects, layer effect | procedural | the area's own photo, warped |
| Crack and rebuild | Before Effects, keyframed 2D pieces | procedural | ordinary layers |
| Light, colour, text and picture effects | Before Effects | procedural | ordinary layers |

The built-in physical effects (Rapier) and the Blender ones are separate options; neither replaces the other. The built-in ones can be adjusted live. Blender gives its own simulation and look, but it returns a video.

**What Blender returns.**
1. Blender renders PNG frames with transparency.
2. Before Effects makes them into a ProRes 4444 video with alpha.
3. The video becomes an ordinary layer lined up with the canvas.

No geometry comes back. The `.blend`, with its baked simulation, stays on disk for **Open in Blender** and **Update from Blender**.

## What updates when

### Immediately
| Effect | Settings |
|---|---|
| Every layer | name, show/hide, opacity, how it mixes (blend), clipping (soft edge, grow, strength, invert), Blur/Glow/Melt and their settings, start and length, position, size and turn |
| Particles | everything: kind, areas, amount, size, speed, how long each lasts, wind, every colour, when they're born, shuffle |
| Light, colour, text, picture effects, Crack and rebuild | every setting, including glow size, fades, shuffle and areas (their layers are rebuilt at once) |
| 3D layers | surface (photo, colour, picture, shadows only), tint, glow, roughness, metallic, how solid, shadows on/off, lights, camera distance, keep inside the area |
| Moving parts | motion, hinge, angle, timing, what's behind the opening (except "Fall off": see below) |
| 2D smoke and water | colour, colour where thickest / highlight, strength, glowing |

### Prepared again in Before Effects
This takes seconds, in the background, and the preview plays as far as it's ready.

| Effect | Settings |
|---|---|
| Collapse, Explode, Crumble (Rapier) | piece size, when it breaks, rebuild on/off and timing, push, tumble, lets go over, shuffle, mass, friction, bounce, gravity (including toward the audience), thickness, the areas, physics on/off, the layer's length |
| 2D smoke and water | amount, rise, swirl, wind, updraft, gusts, lingers, comes from, push, already smoking, stops after, weight, fill/pour, detail, variation, duration, the areas |

### Blender runs again (about 20 s to 2 min, video replaced in the same layer)
| Effect | Settings |
|---|---|
| Blender effects ("Simulate again") | every effect setting (colour, thickness, swirl, lingers, fuel, push, pours for, lets go at, piece size, breaks at, lets go over, tumble, bounce, friction, variation), the areas, start, length and quality. A change to the house areas, or to a Rapier collapse the effect flows around, also needs a new run. Rebuilding replaces edits made in Blender. |
| **Update from Blender** | Blender bakes your edited `.blend` again and renders it. Your edits are kept. |

Colour-only changes to a Blender effect still re-run the simulation today; a render-only path for look changes is possible later.

## Settings added in this pass

- **Light effects:** glow size; Pulse and Move with the beat get Shuffle for the random order; Neon gets the number of flickers; Trace with light gets its fade-in.
- **Fill with colour:** fade out, blend, glow.
- **Show a picture or video:** edge softness, fade out.
- **Text, as an effect and as a layer:** weight, alignment, line and letter spacing, outline (colour and width, animatable), position offsets.
- **Smoke rising:** colour where thickest, strength, comes from, push, updraft, gusts, already smoking, stops after.
- **Water:** highlight colour, strength, glowing, comes from, push, sideways push, choppiness, stops after.
- **Crack and rebuild:** glow size, crack width, fall time, how long the pieces stay gone, fly-back time, throw distance, spin.
- **Every recipe:** rename it and change its areas.
- **3D:**
  - scene name;
  - gravity toward the audience;
  - camera distance;
  - per-axis size;
  - ◆ on turn and size;
  - the point it turns about;
  - shadows on/off;
  - plane size;
  - the areas a solid is made from;
  - metallic and how solid;
  - a picture surface;
  - the layer's own opacity, blend, timing and clipping.
- **Moving parts:** the wall colour behind an opening; start time up to the scene's length.
- **Layers:**
  - an Effects section (Blur, Glow, Melt: every setting with ◆);
  - Clipping (masks);
  - Loop for video;
  - separate width and height;
  - volume and pan keep their keyframes.
- **Blender:** every effect setting plus name, areas, start, length and quality in the "Made in Blender" panel.

Not editable by design: assumed depths are shown as notes, and colour transparency (alpha) isn't offered because opacity covers it.
