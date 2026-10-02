/** Background beat analysis so the editor stays responsive while a song is analysed. */
import { analyzeMusic, toMono } from "@be/core";

self.onmessage = (e: MessageEvent<{ id: number; channels: Float32Array[]; sampleRate: number }>) => {
  const { id, channels, sampleRate } = e.data;
  try {
    const analysis = analyzeMusic(toMono(channels), sampleRate);
    (self as unknown as Worker).postMessage({ id, analysis });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
