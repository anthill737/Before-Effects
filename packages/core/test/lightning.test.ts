import { describe, expect, it } from "vitest";
import {
  type Asset,
  boltStrokes,
  crackSamples,
  createRegistry,
  emptyProject,
  evalKeyframes,
  flickers,
  generatedLayerId,
  History,
  lightning,
  newComposition,
  newProjector,
  polygonPath,
  type Region,
  secondsToTime,
  soundHits,
  soundPart,
  strikeAt,
  strikeTimes,
  thunderSamples,
  timeToSeconds,
  type Venue,
  wavFile,
} from "../src/index.ts";

const venue = (): Venue => {
  const regions: Record<string, Region> = {
    wall: { id: "wall", name: "Wall", kind: "wall", tags: [], path: polygonPath([[100, 200], [900, 200], [900, 650], [100, 650]]) },
    door: { id: "door", name: "Door", kind: "door", tags: [], path: polygonPath([[450, 450], [550, 450], [550, 650], [450, 650]]) },
  };
  const v: Venue = { id: "v1", name: "Test", kind: "flat", canvas: { width: 1000, height: 700 }, regionOrder: Object.keys(regions), regions, groups: {}, projectorOrder: [], projectors: {} };
  return { ...v, projectors: { p1: newProjector(v, { id: "p1" }) }, projectorOrder: ["p1"] };
};

const F = secondsToTime(1);
/** A made-up sound: silence, a hit at 2 s, a bigger one at 6 s. */
const sound = (id: string): Asset => ({
  id,
  kind: "audio",
  name: `${id}.wav`,
  path: `${id}.wav`,
  meta: { duration: secondsToTime(12) },
  analysis: {
    version: 2,
    bpm: 0,
    beats: [],
    downbeatOffset: 0,
    strengths: [],
    hits: [
      { at: 2 * F, peak: 2.2 * F, level: -12, length: 2 * F },
      { at: 6 * F, peak: 6.3 * F, level: -6, length: 3 * F },
    ],
  },
});

const setup = (params: Record<string, unknown> = {}) => {
  const history = new History(emptyProject("Test"), createRegistry());
  const v = venue();
  const comp = newComposition({ id: "main", width: 1000, height: 700, durationSeconds: 30, venueId: v.id });
  history.apply([
    { type: "venue.add", args: { venue: v } },
    { type: "comp.add", args: { comp } },
    { type: "asset.add", args: { asset: sound("crack") } },
    { type: "asset.add", args: { asset: sound("thunder") } },
    { type: "recipe.apply", args: { instanceId: "L", recipeId: lightning.id, compId: comp.id, targets: [{ role: "house", regionIds: ["wall", "door"] }], params: { crackSound: "crack", thunderSound: "thunder", ...params } } },
  ]);
  const layers = history.project.compositions.main!.layers;
  return { history, layers, layer: (role: string) => layers[generatedLayerId("L", role)] };
};

describe("lightning & thunder", () => {
  it("times strikes from the first one, about `every` apart, the same each time", () => {
    const t = strikeTimes(5, 0.5, 3, 1);
    expect(t[0]).toBe(0.5);
    for (let i = 1; i < t.length; i++) expect(t[i]! - t[i - 1]!).toBeGreaterThanOrEqual(0.8 * 3 * 0.65);
    expect(strikeTimes(5, 0.5, 3, 1)).toEqual(t);
    expect(strikeTimes(5, 0.5, 3, 2)).not.toEqual(t);
  });

  it("strikes at exact moments when they're typed in", () => {
    expect(strikeAt("4, 1.5;9.25  x -2")).toEqual([1.5, 4, 9.25]);
    const { layers } = setup({ times: "2, 7.5", crack: false, thunder: false });
    const bolts = Object.values(layers).filter((l) => l.name.startsWith("Lightning bolt"));
    expect(bolts).toHaveLength(2);
    const flash = Object.values(layers).find((l) => l.name.startsWith("Lightning flash"))!;
    if (flash.source.kind !== "shape") throw new Error("shape expected");
    const op = flash.source.contents[0]!.fill!.opacity;
    expect(evalKeyframes(op, secondsToTime(7.5))).toBeGreaterThan(50);
    expect(evalKeyframes(op, secondsToTime(5))).toBe(0);
  });

  it("flickers: brightest first, within about a second", () => {
    const f = flickers(3, 1, 0);
    expect(f[0]).toEqual([0, 1]);
    expect(f[1]![1]).toBeLessThan(1);
    expect(f.at(-1)![0]).toBeLessThan(1.1);
  });

  it("draws bolts in each style inside the scene, the same for the same seed", () => {
    const box = { x: 100, y: 200, w: 800, h: 450 };
    for (const style of ["single", "energetic", "jagged", "crazy"] as const) {
      const a = boltStrokes(style, box, "random", 1, 0, 0);
      expect(a.length).toBeGreaterThan(1);
      expect(boltStrokes(style, box, "random", 1, 0, 0)).toEqual(a);
      for (const line of a) for (const [x, y] of line) {
        expect(x).toBeGreaterThan(box.x - box.w * 0.5);
        expect(x).toBeLessThan(box.x + box.w * 1.5);
        expect(y).toBeGreaterThan(box.y - box.h * 0.6);
        expect(y).toBeLessThan(box.y + box.h * 1.6);
      }
    }
    // A single strike reaches the ground; a branching burst has more strokes.
    const single = boltStrokes("single", box, "centre", 1, 0, 0);
    expect(single[0]!.at(-1)![1]).toBeCloseTo(box.y + box.h);
    expect(boltStrokes("energetic", box, "centre", 1, 0, 0).length).toBeGreaterThan(single.length);
    // Crazy strikes change shape between flickers; single ones don't.
    expect(boltStrokes("crazy", box, "random", 1, 0, 1)).not.toEqual(boltStrokes("crazy", box, "random", 1, 0, 0));
    expect(boltStrokes("single", box, "random", 1, 0, 1)).toEqual(single.length ? boltStrokes("single", box, "random", 1, 0, 0) : []);
  });

  it("flashes the chosen areas with every flicker", () => {
    const { layer } = setup({ strikes: 2, every: 4, firstAt: 1, flickers: 3, flash: 80 });
    const flash = layer("flash")!;
    expect(flash.blendMode).toBe("add");
    if (flash.source.kind !== "shape") throw new Error("shape expected");
    expect(flash.source.contents).toHaveLength(2);
    const op = flash.source.contents[0]!.fill!.opacity;
    const at = (s: number) => evalKeyframes(op, secondsToTime(s));
    expect(at(0.5)).toBe(0);
    expect(at(1)).toBeCloseTo(80);
    expect(at(1.5)).toBeLessThan(80);
    const [o2, b2] = flickers(3, 1, 0)[1]!;
    expect(at(1 + o2)).toBeCloseTo(80 * b2);
  });

  it("plays the crack on the strike and the thunder after, from each sound's biggest hit", () => {
    const { layer } = setup({ strikes: 2, every: 4, firstAt: 1, thunderDelay: 1.5 });
    const crack = layer("crack-0")!;
    const thunder = layer("thunder-0")!;
    expect(crack.source).toEqual({ kind: "audio", assetId: "crack" });
    expect(crack.audioEnabled).toBe(true);
    // The biggest hit (at 6 s in the file) plays from the strike at 1 s.
    expect(timeToSeconds(crack.inPoint)).toBeCloseTo(1);
    expect(timeToSeconds(crack.inPoint - crack.startTime)).toBeCloseTo(6);
    expect(timeToSeconds(thunder.inPoint)).toBeCloseTo(2.5);
    expect(timeToSeconds(thunder.inPoint - thunder.startTime)).toBeCloseTo(6);
    // Second strike too.
    expect(layer("crack-1")).toBeDefined();
    expect(layer("thunder-1")).toBeDefined();
  });

  it("can play a different hit each strike, or from a set time; stops before the next hit", () => {
    const a = sound("x");
    expect(soundPart(a, "hit", 0, 0)).toEqual({ from: 6, until: 12 });
    expect(soundPart(a, "each", 0, 1)).toEqual({ from: 2, until: 6 });
    expect(soundPart(a, "start", 3.5, 0)).toEqual({ from: 3.5, until: 12 });
    // No hits known: a set time.
    expect(soundPart({ ...a, analysis: undefined }, "hit", 1, 0).from).toBe(1);
    const { layer } = setup({ strikes: 2, every: 4, firstAt: 1, crackPart: "each", crackLength: 10 });
    const second = layer("crack-1")!;
    expect(timeToSeconds(second.inPoint - second.startTime)).toBeCloseTo(2);
    expect(timeToSeconds(second.outPoint - second.inPoint)).toBeCloseTo(4);
  });

  it("leaves out sounds that are switched off, and the bolt when it's off", () => {
    const { layers } = setup({ crack: false, thunder: false, bolt: false });
    const roles = Object.values(layers).map((l) => l.name);
    expect(roles.some((n) => /crack|Thunder|bolt/i.test(n))).toBe(false);
    expect(roles).toContain("Lightning flash");
  });

  it("pieces of a bolt move to a new place every flicker", () => {
    const box = { x: 100, y: 200, w: 800, h: 450 };
    const a = boltStrokes("pieces", box, "random", 1, 0, 0);
    const b = boltStrokes("pieces", box, "random", 1, 0, 1);
    expect(a[0]![0]).not.toEqual(b[0]![0]);
    // Slanting down from high on the house.
    const main = a[0]!;
    expect(main.at(-1)![1]).toBeGreaterThan(main[0]![1]);
    expect(main[0]![1]).toBeLessThan(box.y + box.h * 0.4);
  });

  it("the house goes white: a picture in the areas, its opacity keyed to the flickers", () => {
    const history = new History(emptyProject("Test"), createRegistry());
    const v = venue();
    history.apply([
      { type: "venue.add", args: { venue: v } },
      { type: "comp.add", args: { comp: newComposition({ id: "main", width: 1000, height: 700, durationSeconds: 30, venueId: v.id }) } },
      { type: "asset.add", args: { asset: { id: "white", kind: "image", name: "white.png", path: "white.png", meta: { width: 2000, height: 1400 } } } },
      { type: "asset.add", args: { asset: { id: "clip", kind: "video", name: "bolt.mp4", path: "bolt.mp4", meta: { width: 3840, height: 2160, duration: secondsToTime(1.5) } } } },
      { type: "recipe.apply", args: { instanceId: "L", recipeId: lightning.id, compId: "main", targets: [{ role: "house", regionIds: ["wall", "door"] }], params: { strikes: 1, firstAt: 1, flickers: 3, flash: 90, flashPicture: "white", boltClip: "clip", crack: false, thunder: false } } },
    ]);
    const layers = history.project.compositions.main!.layers;
    const flash = layers[generatedLayerId("L", "flash")]!;
    expect(flash.source).toEqual({ kind: "footage", assetId: "white", loop: true });
    expect(flash.blendMode).toBe("normal");
    expect(flash.masks.map((m) => m.source.kind)).toEqual(["region", "region"]);
    expect(flash.transform.scale.value[0]).toBeCloseTo(50);
    const op = (s: number) => evalKeyframes(flash.transform.opacity, secondsToTime(s));
    expect(op(0.5)).toBe(0);
    expect(op(1)).toBeCloseTo(90);
    // The clip: one piece per flicker, screen-blended, each a different place and moment.
    const pieces = [0, 1, 2].map((v) => layers[generatedLayerId("L", `bolt-0-${v}`)]!);
    for (const l of pieces) {
      expect(l.source).toEqual({ kind: "footage", assetId: "clip" });
      expect(l.blendMode).toBe("screen");
      expect(timeToSeconds(l.outPoint - l.inPoint)).toBeCloseTo(0.26, 1);
    }
    expect(pieces[0]!.transform.position.value).not.toEqual(pieces[1]!.transform.position.value);
    expect(pieces[0]!.inPoint - pieces[0]!.startTime).not.toBe(pieces[1]!.inPoint - pieces[1]!.startTime);
  });

  it("regenerates identically", () => {
    const { history, layers } = setup();
    history.apply({ type: "recipe.update", args: { instanceId: "L", params: {} } });
    expect(history.project.compositions.main!.layers).toEqual(layers);
  });
});

describe("made sounds", () => {
  it("thunder: deterministic, levelled, cracks first then rumbles", () => {
    const [L, R] = thunderSamples(1, { seconds: 4, sampleRate: 8000 });
    expect(L.length).toBe(32000);
    expect(thunderSamples(1, { seconds: 4, sampleRate: 8000 })[0]).toEqual(L);
    let peak = 0;
    for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!));
    expect(peak).toBeCloseTo(0.89, 2);
    const hits = soundHits(L, 8000);
    expect(hits.length).toBeGreaterThan(0);
    expect(timeToSeconds(hits[0]!.at)).toBeLessThan(0.2);
  });

  it("crack: a hit at the very start", () => {
    const [L] = crackSamples(1, { sampleRate: 8000 });
    const hits = soundHits(L, 8000);
    expect(timeToSeconds(hits[0]!.at)).toBeLessThan(0.1);
  });

  it("finds hits after silence, loudest kept, in time order", () => {
    const sr = 8000;
    const s = new Float32Array(sr * 6);
    const burst = (t: number, amp: number) => {
      for (let i = 0; i < sr * 0.5; i++) s[Math.round(t * sr) + i] = amp * Math.sin(i * 0.7) * Math.exp(-i / (sr * 0.2));
    };
    burst(1.5, 0.3);
    burst(4, 0.9);
    const hits = soundHits(s, sr);
    expect(hits).toHaveLength(2);
    expect(timeToSeconds(hits[0]!.at)).toBeCloseTo(1.45, 1);
    expect(timeToSeconds(hits[1]!.at)).toBeCloseTo(3.95, 1);
    expect(hits[1]!.level).toBeGreaterThan(hits[0]!.level);
    expect(soundHits(s, sr, 1).map((h) => h.at)).toEqual([hits[1]!.at]);
  });

  it("writes a 16-bit WAV", () => {
    const wav = wavFile([new Float32Array([0, 1, -1]), new Float32Array([0.5, 0, 0])], 48000);
    const v = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint32(40, true)).toBe(12);
    expect(v.getInt16(44 + 2, true)).toBe(16384);
    expect(v.getInt16(44 + 4, true)).toBe(32767);
    expect(v.getInt16(44 + 8, true)).toBe(-32767);
  });
});
