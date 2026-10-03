import { describe, expect, it } from "vitest";
import { glitchAt, LAYER_EFFECTS, RIPPLE_MAX_DROPS } from "@be/core";
import { GLITCH_UNIFORM_BYTES, GlitchEffect, getEffect, glitchUniforms, RIPPLE_UNIFORM_BYTES, RippleEffect, rippleUniforms } from "../src/effects.ts";
import { GLITCH, MELT, RIPPLE } from "../src/shaders.ts";

/**
 * Byte offsets of a WGSL uniform struct `U` (f32, u32, vec2f, vec4f and array<vec4f, N> members),
 * using WGSL's alignment rules, so the CPU-side packing can be checked without a GPU.
 */
const layoutOf = (wgsl: string): { offsets: Record<string, number>; size: number } => {
  const body = /struct U \{([\s\S]*?)\};/.exec(wgsl)![1]!.replace(/\/\/.*$/gm, "");
  const offsets: Record<string, number> = {};
  let at = 0;
  let maxAlign = 4;
  for (const m of body.matchAll(/(\w+)\s*:\s*(array<[^>]+>|\w+)/g)) {
    const type = m[2]!.replace(/\s+/g, " ");
    const arr = /^array<vec4f, ?(\d+)>$/.exec(type);
    const [align, size] = arr ? [16, 16 * Number(arr[1])] : type === "vec4f" ? [16, 16] : type === "vec2f" ? [8, 8] : type === "f32" || type === "u32" ? [4, 4] : [0, 0];
    expect(align, `unknown type ${type}`).toBeGreaterThan(0);
    at = Math.ceil(at / align) * align;
    offsets[m[1]!] = at;
    at += size;
    maxAlign = Math.max(maxAlign, align);
  }
  return { offsets, size: Math.ceil(at / maxAlign) * maxAlign };
};

const picture = { x: 20, y: 10, w: 200, h: 100 };
const size = { w: 240, h: 120 };

describe("layer effects on the GPU", () => {
  it("every effect a layer can carry is drawn by the engine", () => {
    for (const type of Object.keys(LAYER_EFFECTS)) expect(getEffect(type)?.title).toBe(LAYER_EFFECTS[type]!.title);
  });

  it("Melt's uniform block is still four floats", () => {
    expect(layoutOf(MELT).size).toBe(16);
  });
});

describe("Ripple uniforms", () => {
  it("match the shader's struct layout", () => {
    const L = layoutOf(RIPPLE);
    expect(RIPPLE).toContain(`array<vec4f, ${RIPPLE_MAX_DROPS}>`);
    expect(L.size).toBe(RIPPLE_UNIFORM_BYTES);
    expect(L.offsets).toEqual({ size: 0, strength: 8, wavelength: 12, speed: 16, fade: 20, rings: 24, count: 28, light: 32, drops: 48 });
  });

  it("pack the settings in texture pixels, with the drop placed on the layer's own picture", () => {
    const p = { strength: 10, wavelength: 50, speed: 100, decay: 0.5, rings: 3, centerX: 25, centerY: 50, highlight: 0.4, highlightColor: [1, 0.5, 0, 1], rain: 0, seed: 1 };
    const u = rippleUniforms(p, 1.25, size, picture, 2)!;
    expect(u.byteLength).toBe(RIPPLE_UNIFORM_BYTES);
    expect([...u.slice(0, 8)]).toEqual([240, 120, 20, 100, 200, Math.fround((0.5 * 4) / (Math.hypot(200, 100) / 2)), 3, 1]);
    expect([...u.slice(8, 12)]).toEqual([1, 0.5, 0, Math.fround(0.4)]);
    // Drop at 25% across and 50% down the picture (not the padded texture), landed 1.25 s ago.
    expect([...u.slice(12, 16)]).toEqual([70, 60, 1.25, 1]);
    expect([...u.slice(16)].every((v) => v === 0)).toBe(true);
  });

  it("are the same for the same frame, and nothing is drawn for calm water or before the drop", () => {
    const p = { rain: 4, seed: 3 };
    expect(rippleUniforms(p, 5, size, picture, 1)).toEqual(rippleUniforms(p, 5, size, picture, 1));
    expect(rippleUniforms({ strength: 0, highlight: 0 }, 1, size, picture, 1)).toBeNull();
    expect(rippleUniforms({}, -1, size, picture, 1)).toBeNull();
    const rain = rippleUniforms(p, 5, size, picture, 1)!;
    expect(rain[7]).toBeGreaterThan(1);
    expect(rain[7]).toBeLessThanOrEqual(RIPPLE_MAX_DROPS);
  });

  it("pad the layer by the strength (how far it can bend the picture)", () => {
    expect(RippleEffect.expand({ strength: 25 })).toBe(25);
    expect(RippleEffect.expand({})).toBe(LAYER_EFFECTS.ripple!.params.find((x) => x.key === "strength")!.default);
  });
});

describe("Glitch uniforms", () => {
  it("match the shader's struct layout", () => {
    const L = layoutOf(GLITCH);
    expect(L.size).toBe(GLITCH_UNIFORM_BYTES);
    expect(L.offsets).toEqual({ size: 0, strength: 8, slice: 12, shift: 16, split: 20, blocks: 24, scan: 28, scanPeriod: 32, scanOffset: 36, flicker: 40, key: 44 });
  });

  it("pack this moment's burst from the seeded timing", () => {
    // A moment inside a burst.
    let t = 0;
    while (glitchAt(t, 2, 5).strength === 0) t += 1 / 120;
    const p = { amount: 0.5, frequency: 2, shift: 40, slice: 12, split: 6, blocks: 0.3, scanlines: 0.2, seed: 5 };
    const buf = glitchUniforms(p, t, size, 2)!;
    expect(buf.byteLength).toBe(GLITCH_UNIFORM_BYTES);
    const f = new Float32Array(buf, 0, 11);
    const m = glitchAt(t, 2, 5);
    expect(f[0]).toBe(240);
    expect(f[2]).toBeCloseTo(0.5 * m.strength, 6);
    expect([f[3], f[4], f[5]]).toEqual([24, 80, 12]);
    expect(f[7]).toBeCloseTo(0.1, 6);
    expect(new Uint32Array(buf, 44, 1)[0]).toBe(m.key);
    expect(new Uint8Array(glitchUniforms(p, t, size, 2)!)).toEqual(new Uint8Array(buf));
  });

  it("leave the picture clean between bursts, except for scanlines", () => {
    let t = 0;
    while (glitchAt(t, 1, 5).strength > 0) t += 1 / 120;
    const clean = glitchUniforms({ frequency: 1, seed: 5, scanlines: 0.4 }, t, size, 1)!;
    expect(new Float32Array(clean, 0, 11)[2]).toBe(0);
    expect(new Float32Array(clean, 0, 11)[10]).toBe(1);
    expect(glitchUniforms({ frequency: 1, seed: 5, scanlines: 0 }, t, size, 1)).toBeNull();
    expect(glitchUniforms({ amount: 0 }, t, size, 1)).toBeNull();
  });

  it("pad the layer by how far strips jump plus the colour split", () => {
    expect(GlitchEffect.expand({ shift: 100, split: 10 })).toBe(110);
  });
});
