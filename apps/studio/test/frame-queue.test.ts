/** Taking whole frames out of a decoder's pipe without copying everything buffered. */
import { describe, expect, it } from "vitest";
import { FrameQueue } from "../src/main/frameQueue.ts";

describe("frame queue", () => {
  it("takes exact frames across chunk boundaries, in order", () => {
    const q = new FrameQueue();
    const src = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
    // Uneven chunks, like a pipe delivers them.
    for (const [a, b] of [[0, 7], [7, 8], [8, 40], [40, 41], [41, 100]] as const) q.push(src.subarray(a, b));
    expect(q.bytes).toBe(100);
    const frames: number[][] = [];
    for (let f = q.take(30); f; f = q.take(30)) frames.push([...f]);
    expect(frames.length).toBe(3);
    expect(frames.flat()).toEqual([...src.subarray(0, 90)]);
    expect(q.bytes).toBe(10);
    expect(q.take(11)).toBeNull();
    expect([...q.take(10)!]).toEqual([...src.subarray(90)]);
    expect(q.bytes).toBe(0);
  });

  it("gives each frame its own memory (later pushes and takes don't change it)", () => {
    const q = new FrameQueue();
    const chunk = Buffer.alloc(8, 1);
    q.push(chunk);
    const f = q.take(4)!;
    chunk.fill(9);
    q.push(Buffer.alloc(4, 2));
    q.take(4);
    expect([...f]).toEqual([1, 1, 1, 1]);
  });

  it("stays cheap over many small chunks", () => {
    const q = new FrameQueue();
    const frame = 1920 * 4 * 2; // two rows of 1080p RGBA
    for (let i = 0; i < 5000; i++) q.push(Buffer.alloc(frame / 8, i % 251));
    let n = 0;
    while (q.take(frame)) n++;
    expect(n).toBe(625);
    expect(q.bytes).toBe(0);
  });
});
