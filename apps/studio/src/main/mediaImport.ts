/**
 * Import media: copy into the project's media folder (originals untouched), inspect with ffprobe,
 * and prepare what the editor needs: dimensions, frame rate, frame count, duration and audio.
 * Videos with sound get a WAV copy of their audio so preview and export mix exactly the same samples.
 * Files in Google Drive are copied the same way (Drive for desktop downloads them as they're read), so
 * playback and rendering always use a local copy; the asset remembers its place in Drive.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { copyFile, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { ipcMain } from "electron";
import { findFfmpeg } from "@be/media";
import type { ImportedMedia } from "../shared/api.ts";
import { driveRelative } from "../shared/drive.ts";
import { myDrive } from "./drive.ts";
import { paths } from "./files.ts";
import { decodeHeif, isHeif } from "./heic.ts";
import { log } from "./log.ts";

const execFileP = promisify(execFile);

const IMAGE_CODECS = new Set(["png", "mjpeg", "jpegls", "webp", "bmp", "tiff", "gif", "jpeg2000", "exr"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif", ".exr"]);

const uniqueTarget = (dir: string, name: string): string => {
  let target = join(dir, name);
  let n = 1;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  while (existsSync(target)) target = join(dir, `${stem} (${++n})${ext}`);
  return target;
};

const parseRate = (r: string | undefined): { num: number; den: number } | undefined => {
  if (!r) return undefined;
  const [n, d] = r.split("/").map(Number);
  if (!n || !d) return undefined;
  return { num: n, den: d };
};

/** A .gltf that refers to other files (textures, .bin) can't be read once copied on its own. */
const gltfOutsideFiles = async (file: string): Promise<string[]> => {
  try {
    const j = JSON.parse(await readFile(file, "utf8")) as { buffers?: Array<{ uri?: string }>; images?: Array<{ uri?: string }> };
    return [...(j.buffers ?? []), ...(j.images ?? [])].map((x) => x.uri).filter((u): u is string => !!u && !u.startsWith("data:"));
  } catch {
    return [];
  }
};

export const importMedia = async (src: string, projectId: string): Promise<ImportedMedia> => {
  const { ffmpeg, ffprobe } = await findFfmpeg();
  const dir = join(paths().media, projectId.replace(/[^\w.-]+/g, "_"));
  const ext = extname(src).toLowerCase();
  if (ext === ".glb" || ext === ".gltf") {
    if (ext === ".gltf" && (await gltfOutsideFiles(src)).length)
      throw new Error(`“${basename(src)}” refers to other files (textures or .bin). Export it as a single .glb file (in Blender: File → Export → glTF 2.0, format "glTF Binary").`);
    mkdirSync(dir, { recursive: true });
    const target = uniqueTarget(dir, basename(src));
    await copyFile(src, target);
    const root = myDrive();
    const rel = root ? driveRelative(root, src) : null;
    log(`imported 3D model ${src} → ${target}`);
    return { kind: "model", path: target, originalPath: src, ...(rel ? { drive: rel } : {}), name: basename(src) };
  }
  mkdirSync(dir, { recursive: true });
  const target = uniqueTarget(dir, basename(src));
  // Not blocking: a file streamed from Google Drive downloads while it's copied.
  await copyFile(src, target);
  const [a, b] = await Promise.all([stat(src), stat(target)]);
  if (a.size !== b.size) throw new Error(`“${basename(src)}” didn't copy completely (${b.size} of ${a.size} bytes). If it's in Google Drive, check that Drive for desktop is running and try again.`);
  const root = myDrive();
  const rel = root ? driveRelative(root, src) : null;
  const drive = rel ? { drive: rel } : {};
  // Phone photos (HEIC/HEIF): keep the original, work from a decoded PNG.
  if (isHeif(target)) {
    const png = uniqueTarget(dir, `${basename(target, extname(target))} (decoded).png`);
    const r = await decodeHeif(target, png);
    log(`imported image ${src} → ${png} (from ${target})`);
    return { kind: "image", path: r.path, originalPath: src, ...drive, sourceFile: target, name: basename(src), width: r.width, height: r.height, hasAlpha: r.hasAlpha, codec: `heif (${r.decoder})`, notes: r.notes };
  }
  const { stdout } = await execFileP(ffprobe, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", target], { maxBuffer: 16 << 20 });
  const j = JSON.parse(stdout) as { streams: Array<Record<string, string | number | undefined>>; format: Record<string, string | number | undefined> };
  const video = j.streams.find((s) => s.codec_type === "video");
  const audio = j.streams.find((s) => s.codec_type === "audio");
  const duration = Number(j.format.duration ?? video?.duration ?? audio?.duration ?? 0);
  const isImage = !!video && (IMAGE_EXT.has(extname(target).toLowerCase()) || (IMAGE_CODECS.has(String(video.codec_name)) && !(duration > 0.2)));
  let kind: ImportedMedia["kind"] = isImage ? "image" : video ? "video" : audio ? "audio" : "unknown";
  if (kind === "unknown") throw new Error(`“${basename(src)}” isn't an image, video or sound file Before Effects can read.`);
  const rate = video ? (parseRate(String(video.avg_frame_rate)) ?? parseRate(String(video.r_frame_rate))) : undefined;
  const fps = rate ? rate.num / rate.den : 0;
  let audioPath: string | undefined;
  if (audio && kind !== "image") {
    // Decode the sound once to a WAV next to the media, for identical preview and export mixing.
    audioPath = kind === "audio" && extname(target).toLowerCase() === ".wav" ? target : uniqueTarget(dir, `${basename(target, extname(target))}.audio.wav`);
    if (audioPath !== target) await execFileP(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", target, "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", audioPath], { maxBuffer: 1 << 20 });
  }
  if (kind === "video" && fps <= 0) kind = "image";
  const out: ImportedMedia = {
    kind,
    path: target,
    originalPath: src,
    ...drive,
    name: basename(src),
    width: video ? Number(video.width) : undefined,
    height: video ? Number(video.height) : undefined,
    frameRate: kind === "video" ? rate : undefined,
    frameCount: kind === "video" && fps > 0 ? Math.max(1, Math.round(duration * fps)) : undefined,
    durationSeconds: duration || undefined,
    hasAlpha: video ? /a|rgba|bgra|argb|yuva/.test(String(video.pix_fmt)) && /yuva|rgba|bgra|argb|ya|gbrap/.test(String(video.pix_fmt)) : false,
    audioPath,
    sampleRate: audio ? Number(audio.sample_rate) : undefined,
    audioChannels: audio ? Number(audio.channels) : undefined,
    codec: String(video?.codec_name ?? audio?.codec_name ?? ""),
  };
  log(`imported ${kind} ${src} → ${target}${audioPath ? ` (+ audio ${audioPath})` : ""}`);
  return out;
};

export const registerMediaImportIpc = () => {
  ipcMain.handle("media:import", (_e, src: string, projectId: string) => importMedia(src, projectId));
};
