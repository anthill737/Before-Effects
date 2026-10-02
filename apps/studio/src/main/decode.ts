/**
 * Video frame decoding with FFmpeg for preview and export.
 *
 * Decoder processes stream frames forward. A request reuses a stream for that file and size whose
 * queue will reach the frame by reading ahead; otherwise it starts another stream with an accurate
 * seek (`-ss` before `-i`, which decodes from the previous keyframe and discards up to the exact
 * time). Several streams per file let one video play at two different times (a crossfade between
 * scenes) without the streams restarting each other. Frames come back as RGBA bytes. Export asks at full size and preview at the preview size, so preview size never
 * affects export quality.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { ipcMain } from "electron";
import { findFfmpeg } from "@be/media";
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
  buffered: Buffer[];
  bufferedBytes: number;
  waiters: Array<() => void>;
  ended: boolean;
  lastUsed: number;
  chain: Promise<unknown>;
}

const decoders = new Map<number, Decoder>();
const MAX_DECODERS = 8;
const RECENT = 3;
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
  const d: Decoder = { id: ++ids, key: "", proc, next: frame, tail: frame, recent: new Map(), width: w, height: h, frameBytes: w * h * 4, buffered: [], bufferedBytes: 0, waiters: [], ended: false, lastUsed: Date.now(), chain: Promise.resolve() };
  proc.stdout.on("data", (chunk: Buffer) => {
    d.buffered.push(chunk);
    d.bufferedBytes += chunk.length;
    // Back-pressure: pause when a few frames are waiting to be read.
    if (d.bufferedBytes > d.frameBytes * 6) proc.stdout.pause();
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
  while (d.bufferedBytes < d.frameBytes) {
    if (d.ended) return null;
    d.proc.stdout.resume();
    await new Promise<void>((r) => d.waiters.push(r));
  }
  const all = Buffer.concat(d.buffered);
  const frame = all.subarray(0, d.frameBytes);
  const rest = all.subarray(d.frameBytes);
  d.buffered = rest.length ? [rest] : [];
  d.bufferedBytes = rest.length;
  if (d.bufferedBytes <= d.frameBytes * 6) d.proc.stdout.resume();
  const copy = Buffer.from(frame);
  d.recent.set(d.next, copy);
  if (d.recent.size > RECENT) d.recent.delete(d.recent.keys().next().value!);
  d.next++;
  return copy;
};

const stopDecoder = (d: Decoder) => {
  d.ended = true;
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
    if (d.next > frame || (d.ended && d.bufferedBytes < d.frameBytes)) return retry ? decodeFrame(path, frame, fps, width, srcW, srcH, false) : null;
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
  ipcMain.handle("media:decodeFrame", (_e, path: string, frame: number, fps: number, width: number, srcW: number, srcH: number) => decodeFrame(path, frame, fps, width, srcW, srcH));
};
