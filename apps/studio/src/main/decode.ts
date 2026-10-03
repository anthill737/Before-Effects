/**
 * Video frame decoding with FFmpeg for preview and export.
 *
 * Decoder processes stream frames forward. A request reuses a stream for that file and size whose
 * queue will reach the frame by reading ahead; otherwise it starts another stream with an accurate
 * seek (`-ss` before `-i`, which decodes from the previous keyframe and discards up to the exact
 * time). Several streams per file let one video play at two different times (a crossfade between
 * scenes) without the streams restarting each other. Frames come back as RGBA bytes. Export asks at full size and preview at the preview size, so preview size never
 * affects export quality.
 *
 * Memory stays flat over long sessions: each frame is copied out of the pipe on its own (FrameQueue),
 * a stream reads at most a few frames ahead, and streams unused for a minute are closed.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { ipcMain } from "electron";
import { findFfmpeg } from "@be/media";
import { FrameQueue } from "./frameQueue.ts";
import { log } from "./log.ts";
import { track } from "./processes.ts";

interface Decoder {
  id: number;
  key: string;
  proc: ChildProcessWithoutNullStreams;
  /** The frame the stream reads next. */
  next: number;
  /** Where the stream will be once every queued request has run. */
  tail: number;
  /** The last few frames read, for requests that arrive slightly out of order. */
  recent: Map<number, Buffer>;
  width: number;
  height: number;
  frameBytes: number;
  queue: FrameQueue;
  waiters: Array<() => void>;
  ended: boolean;
  lastUsed: number;
  chain: Promise<unknown>;
}

const decoders = new Map<number, Decoder>();
const MAX_DECODERS = 8;
const RECENT = 3;
/** Frames a stream may read ahead before it waits. */
const AHEAD = 4;
/** Streams unused this long are closed (they're started again when needed). */
const IDLE_MS = 60_000;
let ids = 0;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

const start = async (path: string, frame: number, fps: number, width: number, srcW: number, srcH: number): Promise<Decoder> => {
  const { ffmpeg } = await findFfmpeg();
  const w = even(Math.min(width, srcW));
  const h = even((srcH * w) / srcW);
  const seek = frame / fps;
  const args = ["-hide_banner", "-loglevel", "error", ...(seek > 0 ? ["-ss", seek.toFixed(6)] : []), "-i", path, "-an", "-sn", "-vf", `scale=${w}:${h}:flags=bicubic,fps=${fps}`, "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"];
  const proc = spawn(ffmpeg, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  track(`ffmpeg-decode:${path.split(/[\\/]/).pop()}`, proc);
  const d: Decoder = { id: ++ids, key: "", proc, next: frame, tail: frame, recent: new Map(), width: w, height: h, frameBytes: w * h * 4, queue: new FrameQueue(), waiters: [], ended: false, lastUsed: Date.now(), chain: Promise.resolve() };
  proc.stdout.on("data", (chunk: Buffer) => {
    d.queue.push(chunk);
    // Back-pressure: pause when a few frames are waiting to be read.
    if (d.queue.bytes > d.frameBytes * AHEAD) proc.stdout.pause();
    for (const w2 of d.waiters.splice(0)) w2();
  });
  let err = "";
  proc.stderr.on("data", (c: Buffer) => (err += c.toString()));
  proc.on("close", () => {
    d.ended = true;
    if (err.trim()) log(`decoder for ${path}: ${err.trim().slice(0, 400)}`);
    for (const w2 of d.waiters.splice(0)) w2();
  });
  return d;
};

const readFrame = async (d: Decoder): Promise<Buffer | null> => {
  let frame = d.queue.take(d.frameBytes);
  while (!frame) {
    if (d.ended) return null;
    d.proc.stdout.resume();
    await new Promise<void>((r) => d.waiters.push(r));
    frame = d.queue.take(d.frameBytes);
  }
  if (d.queue.bytes <= d.frameBytes * AHEAD) d.proc.stdout.resume();
  d.recent.set(d.next, frame);
  if (d.recent.size > RECENT) d.recent.delete(d.recent.keys().next().value!);
  d.next++;
  return frame;
};

const stopDecoder = (d: Decoder) => {
  d.ended = true;
  d.queue.clear();
  d.recent.clear();
  try {
    d.proc.kill();
  } catch {
    /* already gone */
  }
};

type Decoded = { data: Uint8Array; width: number; height: number };
const wrap = (d: Decoder, b: Buffer): Decoded => ({ data: new Uint8Array(b.buffer, b.byteOffset, b.byteLength), width: d.width, height: d.height });

export const decodeFrame = async (path: string, frame: number, fps: number, width: number, srcW: number, srcH: number, retry = true): Promise<Decoded | null> => {
  const key = `${path}|${even(Math.min(width, srcW))}|${fps}`;
  // Streams that reached the end of their file are of no more use.
  for (const d of decoders.values()) if (d.ended && d.queue.bytes < d.frameBytes && d.recent.size === 0) decoders.delete(d.id);
  const mine = [...decoders.values()].filter((d) => d.key === key);
  for (const d of mine) {
    const hit = d.recent.get(frame);
    if (hit) return wrap(d, hit);
  }
  // A stream whose queue ends at or just before this frame; otherwise a new one seeking to it.
  let dec = mine.filter((d) => !d.ended && frame >= d.tail && frame - d.tail <= 45).sort((a, b) => a.tail - b.tail).at(-1);
  if (!dec) {
    dec = await start(path, frame, fps, width, srcW, srcH);
    dec.key = key;
    decoders.set(dec.id, dec);
    if (decoders.size > MAX_DECODERS) {
      const oldest = [...decoders.values()].filter((d) => d !== dec).sort((a, b) => a.lastUsed - b.lastUsed)[0]!;
      stopDecoder(oldest);
      decoders.delete(oldest.id);
    }
  }
  const d = dec;
  d.tail = Math.max(d.tail, frame + 1);
  d.lastUsed = Date.now();
  // Serialise reads on one stream.
  const job = d.chain.then(async (): Promise<Decoded | null> => {
    const hit = d.recent.get(frame);
    if (hit) return wrap(d, hit);
    // The stream was stopped (or is somehow past the frame): decode it afresh, once.
    if (d.next > frame || (d.ended && d.queue.bytes < d.frameBytes)) return retry ? decodeFrame(path, frame, fps, width, srcW, srcH, false) : null;
    let buf: Buffer | null = null;
    while (d.next <= frame) {
      buf = await readFrame(d);
      if (!buf) return null;
    }
    return buf ? wrap(d, buf) : null;
  });
  d.chain = job.catch(() => undefined);
  return job;
};

export const stopAllDecoders = () => {
  for (const d of decoders.values()) stopDecoder(d);
  decoders.clear();
};

export const registerDecodeIpc = () => {
  // Close streams nobody has used for a while (an idle app keeps no decoders running).
  setInterval(() => {
    const now = Date.now();
    for (const d of [...decoders.values()]) {
      if (now - d.lastUsed < IDLE_MS) continue;
      stopDecoder(d);
      decoders.delete(d.id);
    }
  }, 20_000).unref();
  ipcMain.handle("media:decodeFrame", (_e, path: string, frame: number, fps: number, width: number, srcW: number, srcH: number) => decodeFrame(path, frame, fps, width, srcW, srcH));
};
