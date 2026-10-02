/**
 * FFmpeg sidecar (Node only): locate binaries, encode raw frames with tested presets, probe files,
 * and verify outputs automatically.
 *
 * Only presets this machine's FFmpeg build has actually been checked to produce are offered.
 * `availablePresets()` checks the encoder list, so the UI never lists a format that can't be written.
 */
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface Rational {
  readonly num: number;
  readonly den: number;
}

export interface FfmpegPaths {
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

let cached: FfmpegPaths | null = null;

/** Hook so the host app can track (and clean up) every FFmpeg process it starts. */
let processTracker: ((name: string, proc: ChildProcessWithoutNullStreams) => void) | null = null;
export const setProcessTracker = (fn: (name: string, proc: ChildProcessWithoutNullStreams) => void): void => {
  processTracker = fn;
};

/** Find ffmpeg/ffprobe: BE_FFMPEG_DIR, then PATH, then winget's links folder. */
export const findFfmpeg = async (): Promise<FfmpegPaths> => {
  if (cached) return cached;
  const found = findFfmpegSync();
  if (found) {
    cached = found;
    return found;
  }
  throw new MediaError(
    "Before Effects couldn't find FFmpeg, which it uses to read and save videos.",
    "Reinstall Before Effects, or install FFmpeg with: winget install Gyan.FFmpeg — then restart Before Effects.",
  );
};

/** Synchronous lookup used for startup health checks. Returns null when FFmpeg is missing. */
export const findFfmpegSync = (): FfmpegPaths | null => {
  const exe = process.platform === "win32" ? ".exe" : "";
  const candidates: string[] = [];
  if (process.env.BE_FFMPEG_DIR) candidates.push(process.env.BE_FFMPEG_DIR);
  for (const dir of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) if (dir) candidates.push(dir);
  if (process.platform === "win32") candidates.push(join(homedir(), "AppData", "Local", "Microsoft", "WinGet", "Links"));
  for (const dir of candidates) {
    const ff = join(dir, `ffmpeg${exe}`);
    const fp = join(dir, `ffprobe${exe}`);
    if (existsSync(ff) && existsSync(fp)) return { ffmpeg: ff, ffprobe: fp };
  }
  return null;
};

export class MediaError extends Error {
  readonly userMessage: string;
  readonly action: string;
  constructor(userMessage: string, action: string, readonly details?: string) {
    super(`${userMessage} ${action}${details ? `\n${details}` : ""}`);
    this.userMessage = userMessage;
    this.action = action;
  }
}

// ---------------------------------------------------------------------------------------------
// Presets

export type PresetId = "h264" | "h264-nvenc" | "hevc-nvenc" | "prores-422hq" | "prores-4444" | "dnxhr-hq" | "hap" | "hap-alpha" | "png-sequence";

export interface Preset {
  readonly id: PresetId;
  /** Plain-language name shown to people. */
  readonly label: string;
  readonly purpose: string;
  readonly extension: string;
  readonly encoder: string;
  readonly alpha: boolean;
  /** Raw input pixel format we send (rgba for 8-bit masters, rgba64le for 10/12-bit). */
  readonly input: "rgba" | "rgba64le";
  readonly sequence?: boolean;
  readonly args: readonly string[];
}

const BT709 = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"];

export const PRESETS: Readonly<Record<PresetId, Preset>> = {
  h264: {
    id: "h264",
    label: "Video to share (MP4)",
    purpose: "Plays almost everywhere: phones, browsers, Google Drive previews.",
    extension: "mp4",
    encoder: "libx264",
    alpha: false,
    input: "rgba",
    args: ["-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "17", ...BT709, "-movflags", "+faststart"],
  },
  "h264-nvenc": {
    id: "h264-nvenc",
    label: "Video to share — fast (MP4, NVIDIA)",
    purpose: "Same as the shareable MP4, encoded on the graphics card.",
    extension: "mp4",
    encoder: "h264_nvenc",
    alpha: false,
    input: "rgba",
    args: ["-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "19", "-b:v", "0", ...BT709, "-movflags", "+faststart"],
  },
  "hevc-nvenc": {
    id: "hevc-nvenc",
    label: "Smaller high-quality video (HEVC, NVIDIA)",
    purpose: "Good quality at smaller sizes for media players that support HEVC.",
    extension: "mp4",
    encoder: "hevc_nvenc",
    alpha: false,
    input: "rgba",
    args: ["-vf", "scale=out_color_matrix=bt709:out_range=tv,format=p010le", "-c:v", "hevc_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "20", "-b:v", "0", "-tag:v", "hvc1", ...BT709],
  },
  "prores-422hq": {
    id: "prores-422hq",
    label: "High-quality master (ProRes 422 HQ)",
    purpose: "Editing-grade master with no visible compression.",
    extension: "mov",
    encoder: "prores_ks",
    alpha: false,
    input: "rgba64le",
    args: ["-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv422p10le", "-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0", ...BT709],
  },
  "prores-4444": {
    id: "prores-4444",
    label: "Transparent master (ProRes 4444)",
    purpose: "Keeps transparency for layering in other software or media servers.",
    extension: "mov",
    encoder: "prores_ks",
    alpha: true,
    input: "rgba64le",
    args: ["-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuva444p10le", "-c:v", "prores_ks", "-profile:v", "4", "-alpha_bits", "16", "-vendor", "apl0", ...BT709],
  },
  "dnxhr-hq": {
    id: "dnxhr-hq",
    label: "High-quality master (DNxHR HQ)",
    purpose: "Editing-grade master common on Windows workflows.",
    extension: "mov",
    encoder: "dnxhd",
    alpha: false,
    input: "rgba",
    args: ["-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv422p", "-c:v", "dnxhd", "-profile:v", "dnxhr_hq", ...BT709],
  },
  hap: {
    id: "hap",
    label: "Media-server playback (HAP Q)",
    purpose: "Very smooth playback in Resolume, MadMapper, TouchDesigner and similar.",
    extension: "mov",
    encoder: "hap",
    alpha: false,
    input: "rgba",
    args: ["-vf", "format=rgba", "-c:v", "hap", "-format", "hap_q"],
  },
  "hap-alpha": {
    id: "hap-alpha",
    label: "Media-server playback with transparency (HAP Alpha)",
    purpose: "Like HAP, keeping transparency.",
    extension: "mov",
    encoder: "hap",
    alpha: true,
    input: "rgba",
    args: ["-vf", "format=rgba", "-c:v", "hap", "-format", "hap_alpha"],
  },
  "png-sequence": {
    id: "png-sequence",
    label: "Image sequence (PNG, transparent)",
    purpose: "One lossless image per frame; resumable if interrupted.",
    extension: "png",
    encoder: "png",
    alpha: true,
    input: "rgba",
    sequence: true,
    args: ["-c:v", "png"],
  },
};

let encoderList: Set<string> | null = null;

export const availableEncoders = async (): Promise<Set<string>> => {
  if (encoderList) return encoderList;
  const { ffmpeg } = await findFfmpeg();
  const { stdout } = await execFileP(ffmpeg, ["-hide_banner", "-encoders"], { maxBuffer: 8 << 20 });
  encoderList = new Set(
    stdout
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/)[1])
      .filter((x): x is string => !!x),
  );
  return encoderList;
};

/** Presets whose encoder exists in this FFmpeg build (NVENC also needs a working NVIDIA driver, checked on first use). */
export const availablePresets = async (): Promise<Preset[]> => {
  const enc = await availableEncoders();
  return Object.values(PRESETS).filter((p) => enc.has(p.encoder));
};

// ---------------------------------------------------------------------------------------------
// Encode session

export interface EncodeSpec {
  readonly preset: PresetId;
  /** File path, or for sequences a folder (frames are written as frame_000000.png). */
  readonly output: string;
  readonly width: number;
  readonly height: number;
  readonly frameRate: Rational;
  /** Optional audio file to mux (already mixed and trimmed to the export range). */
  readonly audioPath?: string;
  /** First frame number for sequences (resumable renders continue numbering). */
  readonly startNumber?: number;
  /** Deliver at a smaller size than rendered (high-quality Lanczos scaling in FFmpeg). */
  readonly deliverSize?: { readonly width: number; readonly height: number };
}

export interface EncodeResult {
  readonly ok: boolean;
  readonly output: string;
  readonly framesWritten: number;
  readonly log: string;
  readonly error?: string;
}

/** Prepend a high-quality scale to the preset's filter chain (or add one) for a smaller delivered size. */
const withScale = (args: readonly string[], size?: { width: number; height: number }): string[] => {
  if (!size) return [...args];
  const scale = `scale=${size.width}:${size.height}:flags=lanczos`;
  const out = [...args];
  const i = out.indexOf("-vf");
  if (i >= 0) out[i + 1] = `${scale},${out[i + 1]}`;
  else out.unshift("-vf", scale);
  return out;
};

export class EncodeSession {
  private framesWritten = 0;
  private log = "";
  private exited: Promise<number>;
  private failed: string | null = null;

  private constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    readonly spec: EncodeSpec,
    readonly preset: Preset,
    readonly outputPath: string,
  ) {
    proc.stderr.on("data", (d: Buffer) => {
      this.log += d.toString();
      if (this.log.length > 200_000) this.log = this.log.slice(-100_000);
    });
    proc.stdin.on("error", (e) => {
      this.failed = this.failed ?? e.message;
    });
    this.exited = new Promise((resolve) => proc.on("close", (code) => resolve(code ?? -1)));
  }

  static async start(spec: EncodeSpec): Promise<EncodeSession> {
    const preset = PRESETS[spec.preset];
    if (!preset) throw new MediaError("That export format isn't available.", "Choose another format.");
    const { ffmpeg } = await findFfmpeg();
    let outputPath = spec.output;
    if (preset.sequence) {
      mkdirSync(spec.output, { recursive: true });
      outputPath = join(spec.output, `frame_%06d.${preset.extension}`);
    } else {
      mkdirSync(dirname(spec.output), { recursive: true });
    }
    const rate = `${spec.frameRate.num}/${spec.frameRate.den}`;
    const args = [
      "-hide_banner",
      "-y",
      "-f", "rawvideo",
      "-pix_fmt", preset.input,
      "-s", `${spec.width}x${spec.height}`,
      "-framerate", rate,
      "-i", "pipe:0",
      ...(spec.audioPath ? ["-i", spec.audioPath, "-map", "0:v:0", "-map", "1:a:0", "-c:a", preset.extension === "mp4" ? "aac" : "pcm_s24le", "-b:a", "320k", "-shortest"] : []),
      ...withScale(preset.args, spec.deliverSize),
      "-r", rate,
      ...(preset.sequence ? ["-start_number", String(spec.startNumber ?? 0)] : []),
      outputPath,
    ];
    const proc = spawn(ffmpeg, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    processTracker?.(`ffmpeg-encode:${preset.id}`, proc);
    return new EncodeSession(proc, spec, preset, preset.sequence ? spec.output : outputPath);
  }

  get bytesPerFrame(): number {
    return this.spec.width * this.spec.height * (this.preset.input === "rgba" ? 4 : 8);
  }

  /** Write one frame of raw pixels; resolves when FFmpeg has accepted it (backpressure). */
  async write(frame: Uint8Array): Promise<void> {
    if (this.failed) throw new MediaError("Saving the video stopped unexpectedly.", "Try again, or choose a different format.", this.failed + "\n" + this.log.slice(-2000));
    if (frame.byteLength !== this.bytesPerFrame) throw new Error(`Frame has ${frame.byteLength} bytes, expected ${this.bytesPerFrame}`);
    this.framesWritten++;
    if (!this.proc.stdin.write(frame)) await new Promise<void>((r) => this.proc.stdin.once("drain", () => r()));
  }

  async finish(): Promise<EncodeResult> {
    this.proc.stdin.end();
    const code = await this.exited;
    const ok = code === 0 && !this.failed;
    return {
      ok,
      output: this.outputPath,
      framesWritten: this.framesWritten,
      log: this.log,
      ...(ok ? {} : { error: this.failed ?? lastError(this.log) }),
    };
  }

  cancel(): void {
    this.proc.stdin.destroy();
    this.proc.kill();
  }
}

const lastError = (log: string): string =>
  log
    .split(/\r?\n/)
    .filter((l) => /error|invalid|failed|cannot/i.test(l))
    .slice(-3)
    .join("\n") || "FFmpeg exited with an error.";

// ---------------------------------------------------------------------------------------------
// Probe & verify

export interface ProbeResult {
  readonly width: number;
  readonly height: number;
  readonly frameRate: Rational;
  readonly frames: number;
  readonly durationSeconds: number;
  readonly codec: string;
  readonly pixFmt: string;
  readonly hasAlpha: boolean;
  readonly hasAudio: boolean;
  readonly sizeBytes: number;
}

export const probe = async (path: string, countFrames = true): Promise<ProbeResult> => {
  const { ffprobe } = await findFfmpeg();
  const args = ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", ...(countFrames ? ["-count_frames"] : []), path];
  const { stdout } = await execFileP(ffprobe, args, { maxBuffer: 32 << 20 });
  const j = JSON.parse(stdout) as {
    streams: Array<Record<string, string | number | undefined>>;
    format: Record<string, string | number | undefined>;
  };
  const v = j.streams.find((s) => s.codec_type === "video");
  if (!v) throw new MediaError("That file has no video.", "Choose a video or image file.");
  const [n, d] = String(v.r_frame_rate ?? "0/1").split("/").map(Number);
  const pixFmt = String(v.pix_fmt ?? "");
  return {
    width: Number(v.width),
    height: Number(v.height),
    frameRate: { num: n || 0, den: d || 1 },
    frames: Number(v.nb_read_frames ?? v.nb_frames ?? 0),
    durationSeconds: Number(j.format.duration ?? v.duration ?? 0),
    codec: String(v.codec_name ?? ""),
    pixFmt,
    hasAlpha: /^(yuva|rgba|bgra|argb|abgr|gbrap|ya)|a(64|16)?(le|be)?$/.test(pixFmt) || pixFmt.includes("yuva"),
    hasAudio: j.streams.some((s) => s.codec_type === "audio"),
    sizeBytes: existsSync(path) ? statSync(path).size : 0,
  };
};

export interface VerifyExpectation {
  readonly width: number;
  readonly height: number;
  readonly frameRate: Rational;
  readonly frames: number;
  readonly alpha: boolean;
  readonly audio: boolean;
}

export interface VerifyCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly expected: string;
  readonly actual: string;
}

export interface VerifyReport {
  readonly ok: boolean;
  readonly checks: readonly VerifyCheck[];
  readonly probe: ProbeResult;
}

/** Automatic output verification: resolution, frame rate, frame count, duration, alpha and sound. */
export const verifyOutput = (p: ProbeResult, e: VerifyExpectation): VerifyReport => {
  const fps = e.frameRate.num / e.frameRate.den;
  const expectDur = e.frames / fps;
  const checks: VerifyCheck[] = [
    { name: "Resolution", ok: p.width === e.width && p.height === e.height, expected: `${e.width}×${e.height}`, actual: `${p.width}×${p.height}` },
    {
      name: "Frame rate",
      ok: p.frameRate.num * e.frameRate.den === e.frameRate.num * p.frameRate.den,
      expected: `${e.frameRate.num}/${e.frameRate.den}`,
      actual: `${p.frameRate.num}/${p.frameRate.den}`,
    },
    { name: "Frame count", ok: p.frames === e.frames, expected: String(e.frames), actual: String(p.frames) },
    { name: "Duration", ok: Math.abs(p.durationSeconds - expectDur) <= 1.5 / fps, expected: `${expectDur.toFixed(3)} s`, actual: `${p.durationSeconds.toFixed(3)} s` },
    { name: "Transparency", ok: p.hasAlpha === e.alpha, expected: e.alpha ? "yes" : "no", actual: p.hasAlpha ? "yes" : "no" },
    { name: "Sound", ok: p.hasAudio === e.audio, expected: e.audio ? "yes" : "no", actual: p.hasAudio ? "yes" : "no" },
  ];
  return { ok: checks.every((c) => c.ok), checks, probe: p };
};
