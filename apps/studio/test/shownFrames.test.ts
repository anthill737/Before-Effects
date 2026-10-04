/** Playback counted from the frames put on screen: frames never shown, and the picture going back. */
import { describe, expect, it } from "vitest";
import { unshownBetween } from "../src/shared/shownFrames.ts";

describe("frames never shown while playing", () => {
  it("counts none for frames shown one after another, or the same frame again", () => {
    expect(unshownBetween(100, 101, null, 0, 30)).toEqual({ unshown: 0, back: false });
    expect(unshownBetween(100, 100, null, 0, 30)).toEqual({ unshown: 0, back: false });
    expect(unshownBetween(-1, 500, null, 0, 30)).toEqual({ unshown: 0, back: false });
  });

  it("counts the frames passed over, whether the clock jumped or a frame wasn't ready in time", () => {
    expect(unshownBetween(100, 102, null, 0, 30).unshown).toBe(1);
    expect(unshownBetween(100, 110, null, 0, 30).unshown).toBe(9);
  });

  it("counts round the loop from the range's last frame back to its first", () => {
    // Range 300–599: last shown 599, then 300 — nothing passed over.
    expect(unshownBetween(599, 300, 599, 300, 30)).toEqual({ unshown: 0, back: false });
    // Last shown 597 (598 and 599 never shown), then 301 (300 never shown).
    expect(unshownBetween(597, 301, 599, 300, 30)).toEqual({ unshown: 3, back: false });
  });

  it("treats seconds apart as a seek, not frames passed over", () => {
    expect(unshownBetween(100, 100 + 30 * 6, null, 0, 30).unshown).toBe(0);
    expect(unshownBetween(1000, 100, null, 0, 30)).toEqual({ unshown: 0, back: false });
  });

  it("notices the picture going back a little (frames shown again)", () => {
    expect(unshownBetween(100, 99, null, 0, 30)).toEqual({ unshown: 0, back: true });
    expect(unshownBetween(100, 97, null, 0, 30).back).toBe(true);
  });
});
