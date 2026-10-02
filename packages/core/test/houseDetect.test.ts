import { describe, expect, it } from "vitest";
import { convexHull, splitOutline } from "../src/areaShapes.ts";
import { type Box, buildProposals, closeMask, fillBox, fitQuadRobust, maskArea, fitQuad, largestComponent, type BitMask, pointsBox, type RawDetection, selectCandidates, simplify, topContour, traceOutline } from "../src/houseDetect.ts";

const B = (x0: number, y0: number, x1: number, y1: number): Box => ({ x0, y0, x1, y1 });
const IMG = { width: 1920, height: 1080 };

/** A made-up house front: what the detector typically returns, including its usual mistakes. */
const DETS: RawDetection[] = [
  { label: "house", score: 0.88, box: B(20, 40, 1600, 800) },
  { label: "house", score: 0.4, box: B(0, 300, 120, 700) }, // the neighbour's house, partly in view
  { label: "garage door", score: 0.68, box: B(160, 420, 680, 690) },
  { label: "door", score: 0.31, box: B(165, 425, 675, 685) }, // the garage door again, as a "door"
  { label: "door", score: 0.84, box: B(850, 390, 960, 620) },
  { label: "garage door", score: 0.58, box: B(852, 392, 958, 618) }, // the front door again, as a "garage door"
  { label: "window", score: 0.82, box: B(1100, 380, 1340, 565) },
  { label: "window", score: 0.45, box: B(1105, 385, 1215, 560) }, // a pane of that window
  { label: "window", score: 0.44, box: B(1222, 385, 1335, 560) }, // and the other pane
  { label: "window", score: 0.35, box: B(400, 500, 460, 560) }, // a panel of the garage door
  { label: "window", score: 0.6, box: B(0, 450, 30, 520) }, // the neighbour's window (off the house)
  { label: "window", score: 0.55, box: B(30, 330, 70, 380) }, // the neighbour's, inside the house box
  { label: "lamp", score: 0.77, box: B(700, 405, 736, 478) },
  { label: "lamp", score: 0.54, box: B(400, 260, 440, 290) }, // a bird ornament
  { label: "lamp", score: 0.5, box: B(1150, 400, 1180, 430) }, // a reflection in the window
  { label: "vent", score: 0.36, box: B(523, 108, 580, 188) },
  { label: "column", score: 0.5, box: B(1040, 290, 1088, 655) },
  { label: "roof", score: 0.6, box: B(30, 45, 830, 340) },
  { label: "roof", score: 0.55, box: B(40, 50, 820, 330) }, // a duplicate
  { label: "roof", score: 0.2, box: B(1180, 240, 1580, 300) }, // too unsure to propose
];

describe("selectCandidates", () => {
  const { house, candidates } = selectCandidates(DETS, IMG);
  const of = (kind: string) => candidates.filter((c) => c.kind === kind);

  it("picks the main house, not the neighbour's", () => {
    expect(house?.score).toBe(0.88);
    expect(candidates.some((c) => c.box.x1 < 30)).toBe(false);
  });

  it("settles doors and garage doors by shape", () => {
    expect(of("garage")).toHaveLength(1);
    expect(of("garage")[0]!.box.x0).toBe(160);
    expect(of("door")).toHaveLength(1);
    expect(of("door")[0]!.box.x0).toBe(850);
  });

  it("keeps a whole window rather than its panes, and drops 'windows' inside the garage door", () => {
    expect(of("window").map((w) => w.box)).toEqual([B(1100, 380, 1340, 565), B(30, 330, 70, 380)]);
  });

  it("flags doubtful parts with a reason", () => {
    const lights = of("light");
    expect(lights).toHaveLength(2); // the reflection inside the window is dropped
    expect(lights.find((l) => l.score === 0.54)?.uncertain).toMatch(/decoration.*low confidence/);
    expect(lights.find((l) => l.score === 0.77)?.uncertain).toBeUndefined();
    expect(of("vent")[0]!.uncertain).toMatch(/low confidence \(36%\)/);
    expect(of("roof")).toHaveLength(1);
  });

  it("proposes everything when no house is recognised", () => {
    const r = selectCandidates(DETS.filter((d) => d.label !== "house"), IMG);
    expect(r.house).toBeNull();
    expect(r.notes[0]).toMatch(/No whole house/);
    expect(r.candidates.some((c) => c.box.x1 <= 30)).toBe(true);
  });
});

const rectMask = (w: number, h: number, r: Box): BitMask => {
  const data = new Uint8Array(w * h);
  for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) data[y * w + x] = 1;
  return { width: w, height: h, data };
};

describe("mask outlines", () => {
  it("traces a rectangle and squares it up to four corners", () => {
    const m = rectMask(60, 40, B(10, 5, 50, 30));
    const o = traceOutline(m);
    expect(pointsBox(o)).toEqual(B(10, 5, 49, 29));
    expect(simplify(o, 1, true)).toHaveLength(4);
    expect(fitQuad(o)).toEqual([[10, 5], [49, 5], [49, 29], [10, 29]]);
  });

  it("traces a whole L-shape (not stopping early at the start pixel)", () => {
    const m = rectMask(40, 40, B(5, 5, 10, 35));
    for (let y = 30; y < 35; y++) for (let x = 5; x < 35; x++) m.data[y * 40 + x] = 1;
    const s = simplify(traceOutline(m), 1.5, true);
    expect(s).toHaveLength(6);
    expect(pointsBox(s)).toEqual(B(5, 5, 34, 34));
  });

  it("closes notches and grows and shrinks evenly", () => {
    const m = rectMask(60, 60, B(10, 10, 50, 50));
    for (let y = 30; y < 50; y++) for (let x = 28; x < 31; x++) m.data[y * 60 + x] = 0; // a 3 px slot up from the bottom
    const closed = closeMask(m, 3);
    expect(maskArea(closed)).toBe(40 * 40);
    expect(maskArea(fillBox(rectMask(20, 20, B(0, 0, 0, 0)), B(2, 3, 7, 9)))).toBe(30);
  });

  it("keeps the largest piece", () => {
    const m = rectMask(50, 50, B(2, 2, 6, 6));
    for (let y = 20; y < 45; y++) for (let x = 20; x < 45; x++) m.data[y * 50 + x] = 1;
    expect(pointsBox(traceOutline(largestComponent(m)))).toEqual(B(20, 20, 44, 44));
  });

  it("follows the top of a gable for the roofline", () => {
    const w = 101, h = 60;
    const data = new Uint8Array(w * h);
    for (let x = 0; x < w; x++) for (let y = 10 + Math.abs(x - 50) * 0.6; y < h; y++) data[Math.floor(y) * w + x] = 1;
    const top = simplify(topContour({ width: w, height: h, data }, B(0, 0, 100, 59), 1), 1.5, false);
    expect(top).toHaveLength(3);
    expect(top[1]![1]).toBe(10);
  });
});

describe("buildProposals", () => {
  const sel = selectCandidates(DETS, IMG);
  const garage = sel.candidates.find((c) => c.kind === "garage")!;
  const roof = sel.candidates.find((c) => c.kind === "roof")!;
  // The traced garage door is slightly skewed (perspective); the traced house fills its box.
  const skew: [number, number][] = [[165, 425], [675, 430], [672, 688], [168, 684]];
  const props = buildProposals({
    house: sel.house,
    candidates: sel.candidates,
    shapes: { [garage.key]: { outline: [...skew, [400, 430], [670, 560]], quality: 0.9 } },
    silhouette: { outline: [[120, 300], [420, 40], [900, 300], [1600, 300], [1600, 800], [120, 800]], quality: 0.98 },
    roofline: [[120, 300], [270, 170], [420, 40], [660, 170], [900, 300], [1600, 300]],
  });
  const by = (name: string) => props.find((p) => p.name === name);

  it("names parts and cuts openings out of the facade", () => {
    expect(props[0]!.name).toBe("Facade");
    expect(props[0]!.outline).toBe("traced");
    expect(by("Front door")?.cutFrom).toBe("facade");
    expect(by("Garage door")?.cutFrom).toBe("facade");
    expect(by("Window 2")?.cutFrom).toBe("facade");
    expect(by("Window 2")?.uncertain).toBeUndefined();
    // The neighbour's window is inside the house's box but outside its traced silhouette.
    expect(by("Window 1")?.uncertain).toMatch(/may not be part of this house/);
    expect(by("Light 1")?.cutFrom).toBeUndefined();
  });

  it("uses the traced corners when they agree with the detection, else the box", () => {
    expect(by("Garage door")?.outline).toBe("corners");
    expect(by("Garage door")?.points).toEqual(skew);
    expect(by("Front door")?.outline).toBe("box");
    // Without a traced shape of its own, the roof isn't proposed.
    expect(props.some((p) => p.key === roof.key)).toBe(false);
  });

  it("adds the roofline as an open line along the top of the house", () => {
    const r = by("Roofline")!;
    expect(r.closed).toBe(false);
    expect(r.points).toHaveLength(4);
  });
});

describe("area shapes", () => {
  it("splits a window seen in perspective into two panes along its own sides", () => {
    const quad: [number, number][] = [[0, 0], [100, 10], [100, 90], [0, 100]];
    const [a, b] = splitOutline(quad, "side");
    expect(a).toEqual([[0, 0], [50, 5], [50, 95], [0, 100]]);
    expect(b).toEqual([[50, 5], [100, 10], [100, 90], [50, 95]]);
    const [top, bottom] = splitOutline(quad, "stacked", 0.25);
    expect(top[3]).toEqual([0, 25]);
    expect(bottom[0]).toEqual([0, 25]);
  });

  it("splits other outlines with a straight cut", () => {
    const tri: [number, number][] = [[0, 100], [50, 0], [100, 100]];
    const [l, r] = splitOutline(tri, "side");
    expect(Math.max(...l.map((p) => p[0]))).toBe(50);
    expect(Math.min(...r.map((p) => p[0]))).toBe(50);
  });

  it("finds the hull of separate outlines", () => {
    const h = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [30, 0], [40, 0], [40, 10], [30, 10], [20, 5]]);
    expect(h).toHaveLength(4);
  });
});

describe("four corners, robust to spills", () => {
  it("keeps a garage door's corner on the door when the trace spills onto the column at a corner", () => {
    const m = rectMask(200, 140, B(20, 20, 180, 120));
    // A spill onto the column at the top right.
    for (let y = 12; y < 40; y++) for (let x = 180; x < 192; x++) m.data[y * 200 + x] = 1;
    const o = traceOutline(m);
    const naive = fitQuad(o), robust = fitQuadRobust(o);
    expect(naive[1]![0]).toBeGreaterThan(185);
    expect(robust[1]![0]).toBeCloseTo(179, 0);
    expect(robust[1]![1]).toBeCloseTo(20, 0);
    expect(robust[3]).toEqual([20, 119]);
  });
});
