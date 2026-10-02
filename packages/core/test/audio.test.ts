import { describe, expect, it } from "vitest";
import { analyzeMusic, FLICKS_PER_SECOND } from "../src/index.ts";

/** Synthetic "music": a kick every beat (louder on bar starts) plus a soft hi-hat between beats. */
const synth = (bpm: number, seconds: number, sr = 22050, offset = 0.25): Float32Array => {
  const out = new Float32Array(Math.round(seconds * sr));
  const period = 60 / bpm;
  let seed = 7;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let b = 0; offset + b * period < seconds; b++) {
    const t0 = Math.round((offset + b * period) * sr);
    const amp = b % 4 === 0 ? 1 : 0.6;
    for (let i = 0; i < sr * 0.12 && t0 + i < out.length; i++) {
      const t = i / sr;
      out[t0 + i]! += amp * Math.sin(2 * Math.PI * (60 + 90 * Math.exp(-t * 30)) * t) * Math.exp(-t * 18);
    }
    const h0 = Math.round((offset + (b + 0.5) * period) * sr);
    for (let i = 0; i < sr * 0.03 && h0 + i < out.length; i++) out[h0 + i]! += 0.15 * noise() * Math.exp(-(i / sr) * 120);
  }
  return out;
};

describe("music analysis", () => {
  for (const bpm of [90, 120, 128, 140]) {
    it(`finds ${bpm} BPM and beats within 30 ms`, () => {
      const sr = 22050;
      const a = analyzeMusic(synth(bpm, 20, sr), sr);
      expect(Math.abs(a.bpm - bpm)).toBeLessThan(2);
      const period = 60 / bpm;
      const secs = a.beats.map((b) => b / FLICKS_PER_SECOND);
      // Every detected beat should sit on a real kick.
      const errs = secs.filter((s) => s > 1 && s < 19).map((s) => {
        const k = Math.round((s - 0.25) / period);
        return Math.abs(s - (0.25 + k * period));
      });
      expect(errs.length).toBeGreaterThan(10);
      expect(Math.max(...errs)).toBeLessThan(0.03);
    });
  }
  it("identifies the downbeat phase and is deterministic", () => {
    const sr = 22050;
    const sig = synth(120, 16, sr);
    const a = analyzeMusic(sig, sr);
    const b = analyzeMusic(sig, sr);
    expect(b).toEqual(a);
    const period = 0.5;
    const first = a.beats[a.downbeatOffset]! / FLICKS_PER_SECOND;
    const k = Math.round((first - 0.25) / period);
    expect(((k % 4) + 4) % 4 === 0).toBe(true);
  });
});
