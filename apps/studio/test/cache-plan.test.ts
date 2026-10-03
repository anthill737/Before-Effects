/** Cache recommendations from the hardware, and what they hold. */
import { describe, expect, it } from "vitest";
import { type Footage, fitOf, footageCost, recommendCache } from "../src/shared/cachePlan.ts";

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const show: Footage = { name: "The show", width: 1920, height: 1080, fps: 30, seconds: 19 * 60 + 38 };
const scene: Footage = { name: "Act one", width: 1920, height: 1080, fps: 30, seconds: 150 };

describe("cache recommendations", () => {
  it("gives a 12 GB graphics card about half its memory and prepares a 20-minute show at Full on a roomy drive", () => {
    const p = recommendCache(
      { ramBytes: 31 * GB, gpu: { name: "NVIDIA GeForce RTX 5070 Ti Laptop GPU", bytes: 12 * GB }, drive: { path: "D:", freeBytes: 800 * GB, totalBytes: 1000 * GB } },
      [scene, show],
    );
    expect(p.gpuKind).toBe("dedicated");
    const caches = (p.frameCacheMB + p.videoCacheMB) * MB;
    expect(caches).toBeGreaterThan(6 * GB);
    expect(caches).toBeLessThan(7.5 * GB);
    expect(p.frameCacheMB).toBeGreaterThan(p.videoCacheMB);
    expect(p.frameCacheMB % 256).toBe(0);
    expect(p.resolution).toBe("full");
    // 35,340 frames of 1080p at ~0.9 MB each, with room to spare.
    const need = footageCost(show, "full").frames * footageCost(show, "full").diskFrameBytes;
    expect(p.diskCacheGB * GB).toBeGreaterThan(need);
    expect(p.diskCacheGB).toBeLessThan(60);
    const showFit = p.fits.find((f) => f.name === "The show")!;
    expect(showFit.frames).toBe(35340);
    expect(showFit.diskFits).toBe(true);
    // Graphics memory holds a few seconds of 1080p at a time (16.6 MB a frame).
    expect(showFit.memorySeconds).toBeGreaterThan(5);
    expect(showFit.memorySeconds).toBeLessThan(15);
    expect(p.reasons.join(" ")).toContain("12 GB");
  });

  it("drops to a smaller preview size when the drive can't spare the whole show at Full", () => {
    const p = recommendCache({ ramBytes: 16 * GB, gpu: { name: "Card", bytes: 8 * GB }, drive: { path: "C:", freeBytes: 45 * GB, totalBytes: 256 * GB } }, [show]);
    // 45 GB free, 25.6 GB kept free: ~19 GB to spare. Full needs ~38 GB, Half ~9.5 GB.
    expect(p.resolution).toBe("half");
    expect(p.fits[0]!.diskFits).toBe(true);
    expect(p.reasons.some((r) => r.includes("more disk space than the drive can spare"))).toBe(true);
  });

  it("counts the space preview frames already use as available, and never drops below 10 GB", () => {
    const tight = recommendCache({ ramBytes: 16 * GB, gpu: { name: "Card", bytes: 8 * GB }, drive: { path: "C:", freeBytes: 22 * GB, totalBytes: 200 * GB } }, [show]);
    expect(tight.resolution).toBe("quarter");
    expect(tight.diskCacheGB).toBe(10);
    const reused = recommendCache({ ramBytes: 16 * GB, gpu: { name: "Card", bytes: 8 * GB }, drive: { path: "C:", freeBytes: 22 * GB, totalBytes: 200 * GB }, cacheUsedBytes: 40 * GB }, [show]);
    expect(reused.resolution).toBe("full");
  });

  it("gives a graphics chip that borrows the computer's memory a modest share, and prepares at Half", () => {
    const p = recommendCache({ ramBytes: 16 * GB, gpu: { name: "Intel(R) UHD Graphics", bytes: 128 * MB }, drive: { path: "C:", freeBytes: 300 * GB, totalBytes: 500 * GB } }, [scene]);
    expect(p.gpuKind).toBe("shared");
    expect((p.frameCacheMB + p.videoCacheMB) * MB).toBeLessThanOrEqual(2.6 * GB);
    expect(p.resolution).toBe("half");
  });

  it("uses measured frame sizes when there are some", () => {
    const typical = fitOf(show, "full", 4 * GB, 100 * GB);
    const busy = fitOf(show, "full", 4 * GB, 100 * GB, 0.9);
    expect(busy.diskBytes).toBeCloseTo(typical.diskBytes * 2, -6);
  });
});
