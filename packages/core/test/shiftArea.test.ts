/** Per-area touch-up: only the chosen area moves, by the asked amount, with a sharp edge. */
import { describe, expect, it } from "vitest";
import { calibrationMapping, defaultCalibration, type PathData, shiftAreaCalibration, type Vec2 } from "../src/index.ts";

const rect = (x0: number, y0: number, x1: number, y1: number): PathData => ({
  closed: true,
  vertices: ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as Vec2[]).map((p) => ({ p, in: [0, 0] as Vec2, out: [0, 0] as Vec2 })) as never,
});

describe("per-area touch-up", () => {
  const canvas = { width: 1600, height: 1000 };
  const projector = { output: { width: 1920, height: 1080 }, calibration: defaultCalibration(canvas.width, canvas.height, 1920, 1080) };
  const regions = { door: { path: rect(700, 500, 900, 950) }, window: { path: rect(200, 200, 400, 400) } };

  it("moves the area by the given projector pixels and leaves everything else", () => {
    const before = calibrationMapping(projector, regions)!;
    const next = shiftAreaCalibration(projector, regions, "door", [6, -4]);
    expect(next).not.toBeNull();
    const after = calibrationMapping({ ...projector, calibration: { ...projector.calibration, ...next! } }, regions)!;
    const d = (q: Vec2) => {
      const a = before.toOutput(q), b = after.toOutput(q);
      return [b[0] - a[0], b[1] - a[1]];
    };
    // Inside the door (also near its edge): moved by (6, −4).
    for (const q of [[800, 700], [705, 505], [895, 940]] as Vec2[]) {
      const m = d(q);
      expect(Math.abs(m[0]! - 6)).toBeLessThan(0.3);
      expect(Math.abs(m[1]! + 4)).toBeLessThan(0.3);
    }
    // Just outside its edge, the other window and far away: unmoved.
    for (const q of [[690, 700], [910, 600], [800, 490], [300, 300], [100, 900]] as Vec2[]) {
      const m = d(q);
      expect(Math.hypot(m[0]!, m[1]!)).toBeLessThan(0.3);
    }
    expect(next!.mesh!.surfaces).toEqual(["door"]);
  });

  it("nudges add up, and another area gets its own label", () => {
    const one = { ...projector, calibration: { ...projector.calibration, ...shiftAreaCalibration(projector, regions, "door", [2, 0])! } };
    const two = { ...one, calibration: { ...one.calibration, ...shiftAreaCalibration(one, regions, "door", [2, 0])! } };
    const three = { ...two, calibration: { ...two.calibration, ...shiftAreaCalibration(two, regions, "window", [0, 3])! } };
    const base = calibrationMapping(projector, regions)!, m = calibrationMapping(three, regions)!;
    const door = [m.toOutput([800, 700])[0] - base.toOutput([800, 700])[0], m.toOutput([800, 700])[1] - base.toOutput([800, 700])[1]];
    const win = [m.toOutput([300, 300])[0] - base.toOutput([300, 300])[0], m.toOutput([300, 300])[1] - base.toOutput([300, 300])[1]];
    expect(door[0]).toBeCloseTo(4, 0);
    expect(win[1]).toBeCloseTo(3, 0);
    expect(three.calibration.mesh!.surfaces).toEqual(["door", "window"]);
  });
});
