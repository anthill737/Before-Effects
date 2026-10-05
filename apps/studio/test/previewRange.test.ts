/** The frames a preview plays, by its Range setting (as After Effects). */
import { describe, expect, it } from "vitest";
import { rangeFor } from "../src/shared/previewRange.ts";

const S = 705_600_000;
const comp = { duration: 60 * S, frameRate: { num: 30, den: 1 } };
const wa = { start: 10 * S, end: 20 * S };
const at = (previewRange: "workarea-extended" | "workarea" | "entire" | "around", t: number, workArea: typeof wa | null = wa) => {
  const r = rangeFor(comp, t * S, workArea, { previewRange, aroundBefore: 2, aroundAfter: 5 });
  return [r.start / S, Math.round((r.end / S) * 1000) / 1000];
};

describe("preview range", () => {
  it("work area: the preview range, or the whole scene without one", () => {
    expect(at("workarea", 15)).toEqual([10, 20]);
    expect(at("workarea", 15, null)).toEqual([0, 60]);
  });
  it("work area extended by the playhead: from the playhead when before it, to it when after", () => {
    expect(at("workarea-extended", 15)).toEqual([10, 20]);
    expect(at("workarea-extended", 5)).toEqual([5, 20]);
    expect(at("workarea-extended", 30)).toEqual([10, 30.033]);
  });
  it("entire duration and around the playhead (clamped to the scene)", () => {
    expect(at("entire", 15)).toEqual([0, 60]);
    expect(at("around", 15)).toEqual([13, 20]);
    expect(at("around", 1)).toEqual([0, 6]);
    expect(at("around", 58)).toEqual([56, 60]);
  });
});
