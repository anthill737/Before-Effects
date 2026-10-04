/** Measuring a 3D model on import: extent and collision hull. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeModel } from "../src/models.ts";

describe("model measurements", () => {
  it("measures a pumpkin: its extent, a small hull around it, and what's in the file", async () => {
    const bytes = new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures", "pumpkin.glb")));
    const m = await analyzeModel(bytes);
    const [x0, y0, z0, x1, y1, z1] = m.bounds;
    // About 0.75 m across, 0.6 m tall with its stem (glTF is Y up).
    expect(x1 - x0).toBeGreaterThan(0.65);
    expect(x1 - x0).toBeLessThan(0.85);
    expect(z1 - z0).toBeGreaterThan(0.65);
    expect(y1 - y0).toBeGreaterThan(0.45);
    expect(y1 - y0).toBeLessThan(0.75);
    expect(m.meshes).toBe(2); // skin and stem: one mesh per material, as glTF stores them
    expect(m.triangles).toBeGreaterThan(1000);
    // The hull: at most 64 points, every one inside the extent, reaching its extremes.
    expect(m.hull.length % 3).toBe(0);
    expect(m.hull.length / 3).toBeGreaterThanOrEqual(8);
    expect(m.hull.length / 3).toBeLessThanOrEqual(64);
    const xs = m.hull.filter((_, i) => i % 3 === 0);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan((x1 - x0) * 0.9);
    // The same file always gives the same hull (it's part of the physics description).
    expect((await analyzeModel(bytes)).hull).toEqual(m.hull);
  });
});
