/**
 * HEIC/HEIF photos (what most phones save): detected by their file signature, decoded locally to a
 * lossless PNG working image, original kept unchanged beside it.
 *
 *   1. libheif (WebAssembly, in a worker thread): orientation, crop, tiled grids, transparency.
 *   2. FFmpeg fallback if libheif can't read the file (transparency is then not kept — noted).
 *   3. HDR photos (PQ or HLG transfer) are tone-mapped to SDR explicitly with FFmpeg (Hable curve)
 *      and the conversion is reported, rather than shown washed out.
 *
 * Nothing is uploaded; no codec installation is needed.
 */
import { execFile, spawn } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { findFfmpeg } from "@be/media";
import { log } from "./log.ts";

const execFileP = promisify(execFile);
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "mif2"]);

/** True for HEIC/HEIF files (by content, so renamed files are recognised too). */
export const isHeif = (path: string): boolean => {
  try {
    const fd = openSync(path, "r");
    const b = Buffer.alloc(32);
    readSync(fd, b, 0, 32, 0);
    closeSync(fd);
    if (b.toString("latin1", 4, 8) !== "ftyp") return false;
    const brands = [b.toString("latin1", 8, 12), ...Array.from({ length: 4 }, (_, i) => b.toString("latin1", 16 + i * 4, 20 + i * 4))];
    return brands.some((x) => HEIF_BRANDS.has(x));
  } catch {
    return false;
  }
};

export interface HeifDecoded {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly hasAlpha: boolean;
  readonly decoder: "libheif" | "ffmpeg";
  readonly notes: string[];
}

const libheifDecode = (src: string): Promise<{ width: number; height: number; hasAlpha: boolean; data: Buffer }> =>
  new Promise((resolve, reject) => {
    const w = new Worker(join(__dirname, "heic-worker.js").replace("app.asar", "app.asar.unpacked"), { workerData: { path: src } });
    const timer = setTimeout(() => {
      void w.terminate();
      reject(new Error("decoding took too long"));
    }, 120_000);
    w.once("message", (m: { ok: boolean; error?: string; width: number; height: number; hasAlpha: boolean; data: ArrayBuffer }) => {
      clearTimeout(timer);
      void w.terminate();
      if (m.ok) resolve({ width: m.width, height: m.height, hasAlpha: m.hasAlpha, data: Buffer.from(m.data) });
      else reject(new Error(m.error));
    });
    w.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });

/** Encode RGBA pixels as PNG with FFmpeg (lossless; keeps transparency). */
const encodePng = async (rgba: Buffer, width: number, height: number, out: string, alpha: boolean) => {
  const { ffmpeg } = await findFfmpeg();
  await new Promise<void>((resolve, reject) => {
    const p = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-i", "pipe:0", "-frames:v", "1", "-pix_fmt", alpha ? "rgba" : "rgb24", out], { windowsHide: true });
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited ${code}`))));
    p.stdin.end(rgba);
  });
};

const probeHdr = async (src: string): Promise<{ transfer: string; bits: number }> => {
  try {
    const { ffprobe } = await findFfmpeg();
    const { stdout } = await execFileP(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_transfer,bits_per_raw_sample,pix_fmt", "-of", "json", src]);
    const s = (JSON.parse(stdout) as { streams?: Array<{ color_transfer?: string; bits_per_raw_sample?: string; pix_fmt?: string }> }).streams?.[0];
    return { transfer: s?.color_transfer ?? "", bits: Number(s?.bits_per_raw_sample) || (/10|12/.test(s?.pix_fmt ?? "") ? 10 : 8) };
  } catch {
    return { transfer: "", bits: 8 };
  }
};

/** Decode a HEIC/HEIF photo to `out` (PNG). Throws with an actionable message if it can't be read. */
export const decodeHeif = async (src: string, out: string): Promise<HeifDecoded> => {
  const notes: string[] = [];
  const name = src.split(/[\\/]/).pop();
  const hdr = await probeHdr(src);
  const isHdr = hdr.transfer === "smpte2084" || hdr.transfer === "arib-std-b67";
  if (!isHdr) {
    try {
      const t0 = Date.now();
      const r = await libheifDecode(src);
      await encodePng(r.data, r.width, r.height, out, r.hasAlpha);
      log(`heic: decoded ${name} with libheif (${r.width}×${r.height}${r.hasAlpha ? ", transparency" : ""}) in ${Date.now() - t0} ms`);
      if (hdr.bits > 8) notes.push(`${hdr.bits}-bit colour was reduced to 8 bits.`);
      return { path: out, width: r.width, height: r.height, hasAlpha: r.hasAlpha, decoder: "libheif", notes };
    } catch (e) {
      log(`heic: libheif couldn't read ${name}: ${String((e as Error).message)}; trying FFmpeg`);
      notes.push("Read with the fallback decoder; any transparency in the photo isn't kept.");
    }
  }
  const { ffmpeg, ffprobe } = await findFfmpeg();
  const tonemap = "zscale=t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=pc,format=rgb24";
  try {
    await execFileP(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-frames:v", "1", "-update", "1", ...(isHdr ? ["-vf", tonemap] : []), out], { maxBuffer: 4 << 20 });
  } catch (e) {
    const why = String((e as { stderr?: string }).stderr ?? (e as Error).message).split("\n").find((l) => l.trim()) ?? "unknown error";
    throw new Error(`“${name}” couldn't be decoded (${why.slice(0, 140)}). It may be incomplete, or use a HEIF variant that isn't supported. Export it as JPEG from your phone or Photos app and import that instead.`);
  }
  if (isHdr) notes.push(`HDR photo (${hdr.transfer === "smpte2084" ? "PQ" : "HLG"}) converted to standard range with a Hable tone map.`);
  const { stdout } = await execFileP(ffprobe, ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", out]);
  const [width, height] = stdout.trim().split(",").map(Number);
  log(`heic: decoded ${name} with FFmpeg (${width}×${height})${isHdr ? " with HDR tone mapping" : ""}`);
  return { path: out, width: width!, height: height!, hasAlpha: false, decoder: "ffmpeg", notes };
};
