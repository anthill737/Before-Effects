/**
 * Measure picture/sound timing in a finished file: per-frame mean brightness of the picture and
 * per-frame loudness of the sound, read back with FFmpeg. Used to verify that flashes driven by
 * the music land on the beats in exported videos.
 */
import { spawn } from "node:child_process";
import { ipcMain } from "electron";
import { findFfmpeg, probe } from "@be/media";

const readAll = async (args: string[]): Promise<Buffer> => {
  const { ffmpeg } = await findFfmpeg();
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    p.stdout.on("data", (c: Buffer) => chunks.push(c));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exited ${code}`))));
  });
};

export const measureAvTiming = async (path: string) => {
  const info = await probe(path, false);
  const fps = info.frameRate.num / info.frameRate.den;
  const luma = await readAll(["-v", "error", "-i", path, "-an", "-vf", "scale=32:18,format=gray", "-f", "rawvideo", "pipe:1"]);
  const per = 32 * 18;
  const brightness: number[] = [];
  for (let i = 0; i + per <= luma.length; i += per) {
    let s = 0;
    for (let k = 0; k < per; k++) s += luma[i + k]!;
    brightness.push(s / per);
  }
  let loudness: number[] = [];
  if (info.hasAudio) {
    const pcm = await readAll(["-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1"]);
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    const spf = 48000 / fps;
    const frames = Math.floor(samples.length / spf);
    loudness = Array.from({ length: frames }, (_, f) => {
      let s = 0;
      const a = Math.floor(f * spf);
      const b = Math.floor((f + 1) * spf);
      for (let i = a; i < b; i++) s += (samples[i]! / 32768) ** 2;
      return Math.sqrt(s / Math.max(1, b - a));
    });
  }
  return { fps, brightness, loudness };
};

export const registerAvCheckIpc = () => {
  ipcMain.handle("media:measureAv", (_e, path: string) => measureAvTiming(path));
};
