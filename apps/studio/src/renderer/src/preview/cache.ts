/**
 * Preview frame cache: composited content frames kept on the GPU, keyed by
 * (composition, frame, render fraction, effect quality), within a memory budget (least recently
 * used frames are evicted first). Edits invalidate only frames whose time ranges changed (see
 * core/invalidate.ts). Every view (Show, 3D, Projector) presents from the same cached content.
 * Frames on disk (diskCache.ts) use the same keys and are dropped by the same edits.
 */
import type { Affected, Flicks, Rational } from "@be/core";
import { frameToTime, timeToFrame } from "@be/core";
import { frameKey } from "../../../shared/diskFrames.ts";

interface Entry {
  readonly tex: GPUTexture;
  readonly bytes: number;
  used: number;
}

export interface CacheStats {
  readonly frames: number;
  readonly bytes: number;
  readonly budget: number;
}

export class FrameCache {
  private entries = new Map<string, Entry>();
  private bytes = 0;
  private tick = 0;
  private listeners = new Set<() => void>();

  constructor(private budgetBytes: number) {}

  private key(compId: string, frame: number, fraction: number, quality: string) {
    return `${compId}|${frameKey(frame, fraction, quality)}`;
  }

  setBudget(bytes: number): void {
    this.budgetBytes = bytes;
    this.evict();
  }

  get(compId: string, frame: number, fraction: number, quality: string): GPUTexture | null {
    const e = this.entries.get(this.key(compId, frame, fraction, quality));
    if (!e) return null;
    e.used = ++this.tick;
    return e.tex;
  }

  has(compId: string, frame: number, fraction: number, quality: string): boolean {
    return this.entries.has(this.key(compId, frame, fraction, quality));
  }

  /** Like get(), without counting as a use (saving a frame to disk isn't watching it). */
  peek(compId: string, frame: number, fraction: number, quality: string): GPUTexture | null {
    return this.entries.get(this.key(compId, frame, fraction, quality))?.tex ?? null;
  }

  /**
   * Store a texture; the cache then owns it and destroys it when evicted. Returns false (and does
   * not take ownership) when a single frame is larger than the whole budget.
   */
  put(compId: string, frame: number, fraction: number, quality: string, tex: GPUTexture): boolean {
    const k = this.key(compId, frame, fraction, quality);
    const old = this.entries.get(k);
    if (old) {
      this.bytes -= old.bytes;
      old.tex.destroy();
    }
    const bytes = tex.width * tex.height * (tex.format === "rgba16float" ? 8 : 4);
    if (bytes > this.budgetBytes) return false;
    this.entries.set(k, { tex, bytes, used: ++this.tick });
    this.bytes += bytes;
    this.evict(k);
    this.emit();
    return true;
  }

  /** Evict least-recently-used frames until under budget, never the frame just stored. */
  private evict(keep?: string) {
    if (this.bytes <= this.budgetBytes) return;
    const sorted = [...this.entries.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [k, e] of sorted) {
      if (this.bytes <= this.budgetBytes * 0.9) break;
      if (k === keep) continue;
      e.tex.destroy();
      this.entries.delete(k);
      this.bytes -= e.bytes;
    }
  }

  /** Drop frames of a composition affected by an edit. */
  invalidate(compId: string, affected: Affected, rate: Rational): number {
    if (!affected.all && affected.ranges.length === 0) return 0;
    let n = 0;
    for (const [k, e] of this.entries) {
      const [cid, f] = k.split("|");
      if (cid !== compId) continue;
      const t = frameToTime(Number(f), rate);
      const hit = affected.all || affected.ranges.some(([s, end]) => t >= s && t < end);
      if (hit) {
        e.tex.destroy();
        this.entries.delete(k);
        this.bytes -= e.bytes;
        n++;
      }
    }
    if (n) this.emit();
    return n;
  }

  clear(): void {
    for (const e of this.entries.values()) e.tex.destroy();
    this.entries.clear();
    this.bytes = 0;
    this.emit();
  }

  /** Which frames in [start, end) are cached at this fraction/quality (for the timeline strip). */
  cachedFrames(compId: string, fraction: number, quality: string, start: Flicks, end: Flicks, rate: Rational): Set<number> {
    const out = new Set<number>();
    const f0 = timeToFrame(start, rate);
    const f1 = timeToFrame(end, rate);
    for (let f = f0; f < f1; f++) if (this.entries.has(this.key(compId, f, fraction, quality))) out.add(f);
    return out;
  }

  stats(): CacheStats {
    return { frames: this.entries.size, bytes: this.bytes, budget: this.budgetBytes };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}
