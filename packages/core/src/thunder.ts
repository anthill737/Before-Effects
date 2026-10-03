/**
 * Thunder, made from a seed: a sharp crack and crackles, then a low rumble that rolls in a few swells
 * as it dies away. Deterministic (same seed → same sound), so a show sounds the same every time.
 * Returned as stereo samples and as a 16-bit WAV file for the media library.
 */
import { SeededStream } from "./rng.ts";

export interface ThunderOptions {
  readonly seconds?: number;
  readonly sampleRate?: number;
  /** 0 (far: soft crack, long low rumble) … 1 (close: loud crack, shorter rumble). */
  readonly closeness?: number;
}

export const thunderSamples = (seed: number, o: ThunderOptions = {}): [Float32Array, Float32Array] => {
  const seconds = o.seconds ?? 7;
  const sr = o.sampleRate ?? 48000;
  const close = Math.min(1, Math.max(0, o.closeness ?? 0.6));
  const n = Math.round(seconds * sr);
  const L = new Float32Array(n), R = new Float32Array(n);
  const rng = new SeededStream(seed);
  const r = () => rng.next() * 2 - 1;
  // Swells of the rumble as it rolls around (seconds), and how long it takes to die away.
  const rolls = Array.from({ length: 3 + Math.floor(rng.next() * 3) }, (_, i) => 0.25 + i * (seconds * (0.16 + 0.06 * rng.next())) + rng.next() * 0.35);
  const decay = seconds * (0.36 - 0.12 * close);
  const lp = (hz: number) => 1 - Math.exp((-2 * Math.PI * hz) / sr);
  const aLow = lp(110 + 60 * close), aMid = lp(900);
  let bL = 0, bR = 0, lowL = 0, lowR = 0, midL = 0, midR = 0, crackle = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const wL = r(), wR = 0.65 * wL + 0.35 * r();
    // Brown noise, low-passed: the body of the rumble.
    bL = (bL + 0.03 * wL) * 0.9995;
    bR = (bR + 0.03 * wR) * 0.9995;
    lowL += aLow * (bL - lowL);
    lowR += aLow * (bR - lowR);
    let roll = 0;
    for (const c of rolls) roll += Math.exp(-((t - c) ** 2) / (2 * 0.32 ** 2));
    const rumble = (1 - Math.exp(-t / 0.1)) * Math.exp(-t / decay) * (0.5 + 0.8 * roll) * 9;
    // The crack: a bright burst, then crackles thinning out.
    midL += aMid * (wL - midL);
    midR += aMid * (wR - midR);
    if (rng.next() < 0.004 * Math.exp(-t / (0.35 + 0.3 * close))) crackle = 1;
    crackle *= 0.9965;
    const crack = (0.25 + 0.75 * close) * (Math.exp(-t / 0.05) * 1.2 + crackle * 0.55 * Math.exp(-t / 0.9));
    L[i] = lowL * rumble + (wL * 0.6 + midL * 0.8) * crack;
    R[i] = lowR * rumble + (wR * 0.6 + midR * 0.8) * crack;
  }
  // Gentle ends, then level it to just under full scale.
  const edge = Math.round(0.004 * sr), tail = Math.round(0.5 * sr);
  for (let i = 0; i < n; i++) {
    const g = Math.min(1, i / edge, (n - 1 - i) / tail);
    L[i]! *= g;
    R[i]! *= g;
  }
  let peak = 1e-9;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!));
  const k = 0.89 / peak;
  for (let i = 0; i < n; i++) {
    L[i]! *= k;
    R[i]! *= k;
  }
  return [L, R];
};

/**
 * The crack of a lightning strike, close by: a split-second bright snap, then a hiss of crackles that
 * thins out over about two seconds with a short low thud under it.
 */
export const crackSamples = (seed: number, o: { seconds?: number; sampleRate?: number } = {}): [Float32Array, Float32Array] => {
  const seconds = o.seconds ?? 2.5;
  const sr = o.sampleRate ?? 48000;
  const n = Math.round(seconds * sr);
  const L = new Float32Array(n), R = new Float32Array(n);
  const rng = new SeededStream(seed, 77);
  const r = () => rng.next() * 2 - 1;
  const aLow = 1 - Math.exp((-2 * Math.PI * 140) / sr);
  let prevL = 0, prevR = 0, lowL = 0, lowR = 0, crackle = 0, side = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const wL = r(), wR = 0.5 * wL + 0.5 * r();
    // Bright: noise with its lows taken out (first difference), loud for a few milliseconds.
    const hiL = wL - prevL, hiR = wR - prevR;
    prevL = wL;
    prevR = wR;
    lowL += aLow * (wL - lowL);
    lowR += aLow * (wR - lowR);
    if (rng.next() < 0.012 * Math.exp(-t / 0.6)) {
      crackle = 0.6 + 0.4 * rng.next();
      side = rng.next() * 2 - 1;
    }
    crackle *= 0.992;
    const snap = Math.exp(-t / 0.018) * 1.4 + Math.exp(-t / 0.25) * 0.35;
    const thud = (1 - Math.exp(-t / 0.01)) * Math.exp(-t / 0.35) * 6;
    L[i] = hiL * (snap + crackle * (0.6 - 0.3 * side)) + lowL * thud;
    R[i] = hiR * (snap + crackle * (0.6 + 0.3 * side)) + lowR * thud;
  }
  const tail = Math.round(0.3 * sr);
  let peak = 1e-9;
  for (let i = 0; i < n; i++) {
    const g = Math.min(1, (n - 1 - i) / tail);
    L[i]! *= g;
    R[i]! *= g;
    peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!));
  }
  for (let i = 0; i < n; i++) {
    L[i]! *= 0.89 / peak;
    R[i]! *= 0.89 / peak;
  }
  return [L, R];
};

/** Stereo samples (−1..1) as a 16-bit PCM WAV file. */
export const wavFile = (channels: readonly Float32Array[], sampleRate: number): Uint8Array => {
  const ch = channels.length, n = channels[0]?.length ?? 0;
  const bytes = 44 + n * ch * 2;
  const buf = new ArrayBuffer(bytes);
  const v = new DataView(buf);
  const text = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, bytes - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, n * ch * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < ch; c++) {
      v.setInt16(o, Math.round(Math.max(-1, Math.min(1, channels[c]![i]!)) * 32767), true);
      o += 2;
    }
  return new Uint8Array(buf);
};
