/**
 * Bytes arriving from a decoder's pipe, taken out one whole frame at a time. Only the frame being
 * taken is copied: joining everything buffered for every frame allocated several frames' worth of
 * memory per frame (tens of megabytes per 1080p frame, times every stream, 30 times a second),
 * which could exhaust memory during long sessions and long preparations.
 */
export class FrameQueue {
  private chunks: Buffer[] = [];
  private head = 0;
  private size = 0;

  /** Bytes waiting. */
  get bytes(): number {
    return this.size;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  /** The next `n` bytes as a buffer of their own, or null when fewer are waiting. */
  take(n: number): Buffer | null {
    if (n <= 0 || this.size < n) return null;
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const c = this.chunks[this.head]!;
      const k = Math.min(c.length, n - filled);
      c.copy(out, filled, 0, k);
      filled += k;
      if (k === c.length) {
        this.chunks[this.head] = undefined as unknown as Buffer;
        this.head++;
      } else this.chunks[this.head] = c.subarray(k);
    }
    this.size -= n;
    // Drop the consumed slots now and then (keeps taking cheap without the array growing forever).
    if (this.head > 512 || this.head === this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
    return out;
  }

  clear(): void {
    this.chunks = [];
    this.head = 0;
    this.size = 0;
  }
}
