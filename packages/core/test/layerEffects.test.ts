import { describe, expect, it } from "vitest";
import {
  emptyProject,
  evaluateCompAt,
  GLITCH_MIN_BURST,
  GLITCH_STEPS_PER_SECOND,
  glitchAt,
  isColorSetting,
  LAYER_EFFECTS,
  newComposition,
  newEffect,
  newLayer,
  RAIN_DROP_LIFE,
  rainDropLife,
  RIPPLE_MAX_DROPS,
  rippleDrops,
  secondsToTime,
  staticProp,
} from "../src/index.ts";

describe("Ripple and Glitch settings", () => {
  it("are listed with every setting the inspector shows", () => {
    expect(LAYER_EFFECTS.ripple!.title).toBe("Ripple");
    expect(LAYER_EFFECTS.glitch!.title).toBe("Glitch");
    expect(LAYER_EFFECTS.ripple!.params.map((p) => p.key)).toEqual(["strength", "wavelength", "speed", "decay", "rings", "centerX", "centerY", "highlight", "highlightColor", "rain", "seed"]);
    expect(LAYER_EFFECTS.glitch!.params.map((p) => p.key)).toEqual(["amount", "frequency", "shift", "slice", "split", "blocks", "scanlines", "seed"]);
    for (const spec of Object.values(LAYER_EFFECTS)) {
      expect(new Set(spec.params.map((p) => p.key)).size).toBe(spec.params.length);
      expect(spec.description.length).toBeGreaterThan(10);
      for (const p of spec.params) {
        if (isColorSetting(p)) {
          expect(p.default).toHaveLength(4);
          for (const c of p.default) expect(c >= 0 && c <= 1).toBe(true);
        } else {
          expect(p.step).toBeGreaterThan(0);
          expect(p.min).toBeLessThanOrEqual(p.default);
          expect(p.default).toBeLessThanOrEqual(p.max);
        }
      }
    }
  });

  it("start at their defaults, colours included, and take starting values", () => {
    const r = newEffect("ripple", "fx");
    expect(r.params["centerX"]!.value).toBe(50);
    expect(r.params["highlightColor"]!.value).toEqual([1, 1, 1, 1]);
    const custom = newEffect("ripple", "fx2", { rain: 3, highlightColor: [0.2, 0.6, 1, 1] });
    expect(custom.params["rain"]!.value).toBe(3);
    expect(custom.params["highlightColor"]!.value).toEqual([0.2, 0.6, 1, 1]);
    expect(newEffect("glitch", "g").params["amount"]!.value).toBe(0.6);
    expect(() => newEffect("wobble", "w")).toThrow(/Unknown effect/);
  });

  it("give the effect the layer's own time, in seconds", () => {
    const comp = newComposition({ id: "c", width: 400, height: 300, durationSeconds: 10 });
    const base = newLayer({ id: "L", source: { kind: "solid", color: staticProp([1, 1, 1, 1] as const), width: 100, height: 100 }, start: secondsToTime(2), duration: secondsToTime(5) });
    const layer = { ...base, effects: [newEffect("ripple", "r"), { ...newEffect("glitch", "g"), enabled: false }] };
    const c = { ...comp, layers: { L: layer }, layerOrder: ["L"] };
    const project = { ...emptyProject("T"), compositions: { c } };
    const ev = evaluateCompAt(project, c, secondsToTime(3.5));
    expect(ev.layers[0]!.effects.map((e) => e.type)).toEqual(["ripple"]);
    expect(ev.layers[0]!.effects[0]!.time).toBeCloseTo(1.5, 9);
    expect(ev.layers[0]!.effects[0]!.params["highlightColor"]).toEqual([1, 1, 1, 1]);
  });
});

describe("Ripple drops", () => {
  const one = { rain: 0, centerX: 30, centerY: 70, seed: 1 };

  it("without rain: one drop at the centre, landing when the layer starts", () => {
    expect(rippleDrops(-0.1, one)).toEqual([]);
    expect(rippleDrops(0, one)).toEqual([{ x: 0.3, y: 0.7, age: 0, strength: 1 }]);
    expect(rippleDrops(2.5, one)).toEqual([{ x: 0.3, y: 0.7, age: 2.5, strength: 1 }]);
    expect(rippleDrops(1, { ...one, centerX: 140, centerY: -5 })[0]).toMatchObject({ x: 1, y: 0 });
  });

  it("with rain: the same drops for the same moment, a different pattern for another variation", () => {
    const rain = { ...one, rain: 3, seed: 7 };
    expect(rippleDrops(4.2, rain)).toEqual(rippleDrops(4.2, rain));
    expect(rippleDrops(4.2, rain)).not.toEqual(rippleDrops(4.2, { ...rain, seed: 8 }));
    // An animated "Variation" between whole numbers keeps one pattern (no shimmer).
    expect(rippleDrops(4.2, { ...rain, seed: 7.2 })).toEqual(rippleDrops(4.2, rain));
  });

  it("with rain: drops land inside the picture, fade out over their life, and never exceed the shader's list", () => {
    for (const rate of [0.5, 2, 6, 10]) {
      const life = rainDropLife(rate);
      expect(life).toBeLessThanOrEqual(RAIN_DROP_LIFE);
      let total = 0;
      for (let f = 0; f < 600; f++) {
        const drops = rippleDrops(f / 30, { ...one, rain: rate, seed: 3 });
        expect(drops.length).toBeLessThanOrEqual(RIPPLE_MAX_DROPS);
        total += drops.length;
        for (const d of drops) {
          expect(d.x).toBeGreaterThanOrEqual(0.08);
          expect(d.x).toBeLessThanOrEqual(0.92);
          expect(d.y).toBeGreaterThanOrEqual(0.08);
          expect(d.y).toBeLessThanOrEqual(0.92);
          expect(d.age).toBeGreaterThanOrEqual(0);
          expect(d.age).toBeLessThan(life);
          expect(d.strength).toBeGreaterThan(0);
          expect(d.strength).toBeLessThanOrEqual(1);
        }
      }
      // On average about rate × life drops are alive (minus the first life's ramp-up).
      expect(total / 600).toBeGreaterThan(rate * life * 0.5);
    }
  });

  it("with rain: a drop stays put from frame to frame while it ages and fades", () => {
    const o = { ...one, rain: 2, seed: 5 };
    const a = rippleDrops(6, o);
    const b = rippleDrops(6 + 1 / 30, o);
    let matched = 0;
    for (const d of a) {
      const same = b.find((e) => e.x === d.x && e.y === d.y);
      if (!same) continue;
      matched++;
      expect(same.age - d.age).toBeCloseTo(1 / 30, 9);
      expect(same.strength).toBeLessThan(d.strength);
    }
    expect(matched).toBeGreaterThan(0);
  });
});

describe("Glitch bursts", () => {
  /** Count bursts (clean → glitching) over `seconds`, sampled finer than the shortest burst. */
  const bursts = (frequency: number, seed: number, seconds: number) => {
    let n = 0;
    let was = false;
    for (let i = 0; i < seconds * 240; i++) {
      const on = glitchAt(i / 240, frequency, seed).strength > 0;
      if (on && !was) n++;
      was = on;
    }
    return n;
  };

  it("are the same for the same moment and seed (exports and seeking match preview)", () => {
    for (const t of [0, 0.3, 1.234, 7.5, 59.9]) expect(glitchAt(t, 2, 4)).toEqual(glitchAt(t, 2, 4));
    const a = Array.from({ length: 200 }, (_, i) => glitchAt(i / 30, 2, 1).strength);
    const b = Array.from({ length: 200 }, (_, i) => glitchAt(i / 30, 2, 2).strength);
    expect(a).not.toEqual(b);
  });

  it("hit once per 1 / frequency seconds, clean in between", () => {
    expect(bursts(2, 1, 10)).toBe(20);
    expect(bursts(0.5, 9, 20)).toBe(10);
    for (let i = 0; i < 600; i++) {
      const m = glitchAt(i / 60, 1, 3);
      expect(m.strength).toBeGreaterThanOrEqual(0);
      expect(m.strength).toBeLessThanOrEqual(1);
      if (m.strength === 0) expect(m.flicker).toBe(1);
      else expect(m.flicker).toBeGreaterThan(0.5);
    }
  });

  it("glitch almost all the time at high frequency", () => {
    let on = 0;
    for (let i = 0; i < 300; i++) if (glitchAt(i / 30 + 0.001, 20, 1).strength > 0) on++;
    expect(on).toBe(300);
  });

  it("last at least the shortest burst and change pattern several times a second", () => {
    // Find a burst at a low frequency and step through it.
    let t = 0;
    while (glitchAt(t, 0.5, 2).strength === 0) t += 1 / 240;
    const keys = new Set<number>();
    let end = t;
    while (glitchAt(end, 0.5, 2).strength > 0) {
      keys.add(glitchAt(end, 0.5, 2).key);
      end += 1 / 240;
    }
    expect(end - t).toBeGreaterThanOrEqual(GLITCH_MIN_BURST - 1 / 240);
    expect(keys.size).toBeGreaterThanOrEqual(Math.floor((end - t) * GLITCH_STEPS_PER_SECOND));
    expect(keys.size).toBeLessThanOrEqual(Math.ceil((end - t) * GLITCH_STEPS_PER_SECOND) + 1);
  });
});
