import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EncodeSession, findFfmpegSync } from "../src/index.ts";

// Uses the app's bundled FFmpeg when it has been built, else one on PATH; skipped without either.
const bundled = join(import.meta.dirname, "..", "..", "..", "build", "app", "resources", "bin");
if (!process.env.BE_FFMPEG_DIR && existsSync(join(bundled, "ffmpeg.exe"))) process.env.BE_FFMPEG_DIR = bundled;
const haveFfmpeg = !!findFfmpegSync();
const dir = mkdtempSync(join(tmpdir(), "be-encode-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const frames = async (s: EncodeSession, n: number) => {
  const f = new Uint8Array(s.bytesPerFrame).fill(90);
  for (let i = 0; i < n; i++) await s.write(f);
};

describe.skipIf(!haveFfmpeg)("exporting a video", () => {
  it("is written under a .partial name and appears under its real name only when complete", async () => {
    const out = join(dir, "done.mp4");
    const s = await EncodeSession.start({ preset: "h264", output: out, width: 64, height: 36, frameRate: { num: 30, den: 1 } });
    await frames(s, 20);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.partial`)).toBe(true);
    const r = await s.finish();
    expect(r.ok).toBe(true);
    expect(r.output).toBe(out);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(`${out}.partial`)).toBe(false);
  });

  it("leaves nothing behind when cancelled", async () => {
    const out = join(dir, "cancelled.mp4");
    const s = await EncodeSession.start({ preset: "h264", output: out, width: 64, height: 36, frameRate: { num: 30, den: 1 } });
    await frames(s, 10);
    s.cancel();
    await new Promise((r) => setTimeout(r, 1500));
    expect(readdirSync(dir).filter((f) => f.startsWith("cancelled"))).toEqual([]);
  });

  it("replaces an older file of the same name only once the new one is complete", async () => {
    const out = join(dir, "done.mp4");
    const s = await EncodeSession.start({ preset: "h264", output: out, width: 64, height: 36, frameRate: { num: 30, den: 1 } });
    await frames(s, 5);
    expect(existsSync(out)).toBe(true); // the earlier export is still there while this one runs
    expect((await s.finish()).ok).toBe(true);
    expect(readdirSync(dir).filter((f) => f.startsWith("done"))).toEqual(["done.mp4"]);
  });
});
