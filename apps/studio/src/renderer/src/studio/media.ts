/**
 * Bringing in the person's own media: images, videos, music and sound effects.
 * Files are copied into the project's media folder, inspected, and, for music, analysed for
 * beats in the background. Every change is an ordinary undoable operation.
 */
import { type Asset, type AudioAnalysis, defaultAudio, newId, newLayer, type Op, type OpSource, secondsToTime, type Flicks } from "@be/core";
import { currentComp, useStudio } from "./store.ts";

let worker: Worker | null = null;
let jobId = 0;
const pending = new Map<number, (r: { analysis?: AudioAnalysis; error?: string }) => void>();

const analysisWorker = (): Worker => {
  if (!worker) {
    worker = new Worker(new URL("./analyze.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; analysis?: AudioAnalysis; error?: string }>) => {
      pending.get(e.data.id)?.(e.data);
      pending.delete(e.data.id);
    };
  }
  return worker;
};

let audioCtx: AudioContext | null = null;
const decodeCtx = () => (audioCtx ??= new AudioContext({ sampleRate: 48000 }));

const buffers = new Map<string, Promise<AudioBuffer>>();
/** Decoded sound for an asset (cached). */
export const audioBufferFor = (asset: Asset): Promise<AudioBuffer> | null => {
  const path = asset.audioPath ?? (asset.kind === "audio" ? asset.path : undefined);
  if (!path) return null;
  let p = buffers.get(path);
  if (!p) {
    p = window.be.files.readFile(path).then((bytes) => decodeCtx().decodeAudioData(bytes.slice().buffer));
    buffers.set(path, p);
  }
  return p;
};

/** Analyse music for beats (background worker) and store the result with the project. */
export const analyseBeats = async (asset: Asset): Promise<AudioAnalysis | null> => {
  const buf = await audioBufferFor(asset);
  if (!buf) return null;
  const channels = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i).slice());
  const id = ++jobId;
  const r = await new Promise<{ analysis?: AudioAnalysis; error?: string }>((res) => {
    pending.set(id, res);
    analysisWorker().postMessage({ id, channels, sampleRate: buf.sampleRate }, channels.map((c) => c.buffer));
  });
  if (!r.analysis) {
    window.be.app.log(`beat analysis failed for ${asset.name}: ${r.error}`);
    return null;
  }
  useStudio.getState().apply({ type: "asset.update", args: { assetId: asset.id, changes: { analysis: r.analysis } } }, { label: "Find the beat", source: "system" });
  return r.analysis;
};

/** Import files and return the new assets (already in the project). */
export const importMediaFiles = async (paths?: string[], opts: { quiet?: boolean } = {}): Promise<Asset[]> => {
  const s = useStudio.getState();
  const project = s.project;
  if (!project) return [];
  const files = paths ?? (await window.be.files.chooseFiles("media"));
  const out: Asset[] = [];
  for (const file of files) {
    try {
      const m = await window.be.media.import(file, project.id);
      if (m.kind === "unknown") continue;
      const asset: Asset = {
        id: newId("asset"),
        kind: m.kind,
        name: m.name,
        path: m.path,
        originalPath: m.originalPath,
        ...(m.sourceFile ? { sourceFile: m.sourceFile } : {}),
        ...(m.audioPath ? { audioPath: m.audioPath } : {}),
        meta: {
          ...(m.width ? { width: m.width } : {}),
          ...(m.height ? { height: m.height } : {}),
          ...(m.frameRate ? { frameRate: m.frameRate } : {}),
          ...(m.frameCount ? { frameCount: m.frameCount } : {}),
          ...(m.durationSeconds ? { duration: secondsToTime(m.durationSeconds) } : {}),
          ...(m.hasAlpha !== undefined ? { hasAlpha: m.hasAlpha } : {}),
          ...(m.sampleRate ? { sampleRate: m.sampleRate } : {}),
          ...(m.audioChannels ? { audioChannels: m.audioChannels } : {}),
          ...(m.codec ? { codec: m.codec } : {}),
        },
      };
      if (useStudio.getState().apply({ type: "asset.add", args: { asset } }, { label: `Import ${m.name}` })) out.push(asset);
      for (const n of m.notes ?? []) s.toast({ kind: "info", text: `${m.name}: ${n}` });
    } catch (e) {
      const msg = String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
      // A photo that can't be decoded comes with its own explanation of what to do.
      s.toast({ kind: "error", text: /couldn't be decoded/.test(msg) ? msg : `“${file.split(/[\\/]/).pop()}” couldn't be imported.`, details: msg });
    }
  }
  // Music: find the beat in the background (needed for "Move with the beat").
  for (const a of out) if (a.kind === "audio") void analyseBeats(a);
  if (out.length && !opts.quiet) s.toast({ kind: "success", text: `Imported ${out.length} file${out.length > 1 ? "s" : ""}. ${out.some((a) => a.kind === "audio") ? "Finding the beat of your music…" : ""}` });
  return out;
};

/** Put an asset in the show as its own layer (music/sound from the start; pictures and video full-frame). */
export const addAssetLayer = (asset: Asset, at?: Flicks, opts: { source?: OpSource; group?: string; select?: boolean } = {}): string | null => {
  const s = useStudio.getState();
  const comp = currentComp(s);
  if (!comp) return null;
  const start = at ?? (asset.kind === "audio" ? 0 : s.time);
  const length = asset.meta.duration ?? secondsToTime(10);
  const end = Math.min(comp.duration, start + length);
  const id = newId("layer");
  const ops: Op[] = [];
  if (asset.kind === "audio") {
    ops.push({ type: "layer.add", args: { compId: comp.id, layer: { ...newLayer({ id, name: asset.name, source: { kind: "audio", assetId: asset.id }, start, duration: end - start }), audio: defaultAudio() }, index: comp.layerOrder.length } });
  } else {
    const w = asset.meta.width ?? comp.width;
    const h = asset.meta.height ?? comp.height;
    const k = Math.max(comp.width / w, comp.height / h);
    const base = newLayer({ id, name: asset.name, source: { kind: "footage", assetId: asset.id }, start, duration: end - start });
    ops.push({
      type: "layer.add",
      args: {
        compId: comp.id,
        layer: {
          ...base,
          ...(asset.audioPath ? { audio: defaultAudio() } : {}),
          transform: { ...base.transform, anchor: { value: [w / 2, h / 2, 0] }, position: { value: [comp.width / 2, comp.height / 2, 0], spatial: true }, scale: { value: [k * 100, k * 100, 100] } },
        },
        index: comp.layerOrder.length,
      },
    });
  }
  if (!s.apply(ops, { label: `Add ${asset.name}`, ...(opts.source ? { source: opts.source } : {}), ...(opts.group ? { group: opts.group } : {}) })) return null;
  if (opts.select !== false) useStudio.setState({ selection: { regionIds: [], recipeId: null, layerId: id } });
  return id;
};

/** Most recent imported asset of the given kinds. */
export const latestAsset = (kinds: readonly string[], needsAnalysis = false): Asset | undefined => {
  const p = useStudio.getState().project;
  if (!p) return undefined;
  return Object.values(p.assets)
    .filter((a) => kinds.includes(a.kind) && (!needsAnalysis || (a.analysis?.beats.length ?? 0) > 0))
    .at(-1);
};
