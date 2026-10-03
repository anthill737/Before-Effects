# Smoke and water simulations

_Status 2026-10-02._

## What the person does

1. Select windows, doors or other parts.
2. Choose **Smoke rising** or **Fill with flowing water**, from the effects library, the action bar or the assistant.
3. Adjust plain controls:
   - **Smoke:** Colour, Amount, Rise speed, Swirl, Wind, Lingers for, Glowing, Detail, Variation, Duration.
   - **Water:** Water colour, Fills the parts or Pours down from them, Flow, Weight, Detail, Variation, Duration.

The simulation **prepares in the background**:
- The Inspector shows "Preparing the simulation… 120 of 210 frames" and the preview shows "Simulating 57%".
- It plays as far as it is prepared.
- Changing a setting prepares it again, after a short pause so dragging a slider doesn't restart work on every step.

## Engine evaluation (why our own GPU solvers)

| Option | Verdict |
|---|---|
| **Own WebGPU solvers (chosen)** | Run on the same GPU device as the renderer and need no install. They are deterministic by design and fast: about 10 ms per frame at Normal detail on this PC. Results go straight into the layer pipeline (masks, blend modes, projector warp). |
| Mantaflow / Blender (CLI) | Excellent quality, but it means a heavy extra install, slow round trips through files, and tooling that isn't friendly to non-experts. Now offered alongside, for 3D smoke, fire, water and cloth around the house: see [12-blender.md](12-blender.md). |
| EmberGen / Houdini | Paid, separate apps. Not an integration for an ease-of-use-first tool. |
| WebGL demo solvers (e.g. PavelDoGreat, MIT) | Look-alike, real time, but WebGL, non-deterministic, and they don't fill containers. |

## How it works

- **Smoke** (`packages/engine/src/sim/smoke.ts`) is a 2D Eulerian "stable fluids" solver. Each sub-step runs:
  1. soft-edged emitters
  2. buoyancy (heat rises) and wind
  3. curl-noise gusts and vorticity confinement
  4. midpoint semi-Lagrangian advection
  5. Jacobi pressure projection (floor at the bottom, open sides and top)
  6. density fading over "linger"
- **Water** (`packages/engine/src/sim/water.ts`) is a 2D FLIP liquid with particles and a staggered grid.
  - Particle-to-grid sums use integer atomics, so results don't depend on thread order.
  - The pressure solve keeps open air at the surface, and over-full cells push outward to keep the volume.
  - Solids come from the containers: water stays inside the selected windows.
  - The emitters pour steadily and stop where the water has filled up to them.
  - With open edges, water leaving the picture frees its slot.
- **Reproducible:**
  - Fixed sub-steps per frame, seeded hash noise, and no order-dependent floating-point sums.
  - Verified: a second, independent simulation gives **byte-identical frames** (journey step `sim-reproducible`).
  - Holds on the same PC and driver; other GPUs may differ in the last bits.
- **Preparing is separate from the preview cache** (`packages/engine/src/sim/engine.ts`, `apps/studio/src/renderer/src/studio/simHost.ts`):
  - Every frame is stored on disk as two half floats per cell in `Cache\sims\<key>\f<n>.bin`.
  - A checkpoint of the full solver state is saved every 30 frames, so an interrupted preparation resumes instead of restarting.
  - The cache key is a hash of the settings, the region shapes used, the composition's size and frame rate, and the solver version. Stale frames are never shown.
  - Preview, pop-out, projector window and the background export all read the same stored frames. An export simulates first if anything is missing, which gives identical results.
- **Look:**
  - Smoke is soft, lit from above, and denser parts take the second colour. It can glow (added light) on dark facades.
  - Water is a surface with depth shading, highlights and foam where it moves fast.
  - The look is applied at any resolution from the stored fields.

## Verified (journey steps `sim-*`)

| Check | Result |
|---|---|
| Smoke on 4 windows (6 s, 1 s pre-roll) | 210 frames prepared in about 2 s. Brightness above the windows at 7 s goes from 24 to 48 |
| Reproducible | Frames 10, 60 and 150 are byte-identical in a second run |
| Edit re-prepares | New settings give a new key, prepared again in about 2 s; old frames are kept for undo |
| Water fills 3 windows | 180 frames in about 2–3 s. The bottom of the first window goes from 24 to 150 as it fills |
| Export | A background export of a stretch with the water passes every file check |

## Limits

- 2D simulations in the composition's plane. Smoke and water don't wrap around 3D venue models yet.
- Water is shaded as a surface. It isn't refractive and doesn't show the building through it.
- Fire, explosions and particles with collisions against arbitrary shapes are later effects on the same engine.
- Detail is capped at 384 cells on the long side (High).
