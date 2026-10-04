/**
 * Stereo sound for the show. Preview and export use the same scheduling code:
 *   - every audible layer (music, sound effects, videos with sound) becomes a buffer source with
 *     volume (dB, animatable), pan (animatable), fade-in/out and trimming,
 *   - preview plays it live with Web Audio and becomes the master clock, so picture follows sound,
 *   - export renders the identical graph offline (48 kHz stereo) to a WAV file that FFmpeg muxes in.
 * The bus layout (layer → gain → pan → master) leaves room for multichannel routing later.
 */
import { type Composition, evalProp, type Flicks, FLICKS_PER_SECOND, type Id, type Layer, type Project } from "@be/core";
import { usePreviewStats } from "../preview/loop.ts";
import { audioBufferFor } from "./media.ts";
import { useStudio } from "./store.ts";

const F = FLICKS_PER_SECOND;
const dbToGain = (db: number) => (db <= -60 ? 0 : 10 ** (db / 20));

/**
 * A sound to play, placed on the outer timeline. Sound inside nested scenes (the show's scenes,
 * imported precomps) is lifted out: `a`/`b` map outer time to the layer's own composition time
 * (local = a·t + b), the window is clipped to every container, and `outer` carries the containers'
 * volume and opacity (so a crossfade between scenes crossfades their sound too).
 */
interface Mixable {
  readonly layer: Layer;
  readonly buffer: AudioBuffer;
  readonly a: number;
  readonly b: number;
  readonly from: Flicks;
  readonly to: Flicks;
  readonly outer: (t: Flicks) => number;
}

interface Placed {
  readonly layer: Layer;
  readonly a: number;
  readonly b: number;
  readonly from: Flicks;
  readonly to: Flicks;
  readonly outer: (t: Flicks) => number;
}

const MAX_DEPTH = 8;

const placedSounds = (project: Project, comp: Composition, a = 1, b = 0, from = -Infinity, to = Infinity, outer: (t: Flicks) => number = () => 1, depth = 0): Placed[] => {
  const out: Placed[] = [];
  for (const id of comp.layerOrder) {
    const l = comp.layers[id];
    if (!l || !l.enabled || !l.audioEnabled || l.audio?.muted) continue;
    // The layer's in/out (its composition's time) on the outer timeline.
    const lf = Math.max(from, (l.inPoint - b) / a);
    const lt = Math.min(to, (l.outPoint - b) / a);
    if (lt <= lf) continue;
    if (l.source.kind === "comp") {
      const inner = project.compositions[l.source.compId];
      if (!inner || depth >= MAX_DEPTH || l.stretch <= 0) continue;
      const vol = l.audio;
      const g = (t: Flicks) => {
        const local = a * t + b;
        return outer(t) * (vol ? dbToGain(evalProp(vol.volume, local)) : 1) * Math.max(0, Math.min(1, evalProp(l.transform.opacity, local) / 100));
      };
      out.push(...placedSounds(project, inner, a * l.stretch, (b - l.startTime) * l.stretch, lf, lt, g, depth + 1));
      continue;
    }
    if (l.source.kind !== "audio" && l.source.kind !== "footage") continue;
    const asset = project.assets[l.source.assetId];
    if (!asset || (asset.kind !== "audio" && !asset.audioPath)) continue;
    out.push({ layer: l, a, b, from: lf, to: lt, outer });
  }
  return out;
};

/** True when the composition (or a scene inside it) has sound to play or export. */
export const hasAudio = (project: Project, compId: Id): boolean => {
  const comp = project.compositions[compId];
  return !!comp && placedSounds(project, comp).length > 0;
};

const collect = async (project: Project, compId: Id): Promise<Mixable[]> => {
  const comp = project.compositions[compId];
  if (!comp) return [];
  const out: Mixable[] = [];
  for (const p of placedSounds(project, comp)) {
    const asset = project.assets[(p.layer.source as { assetId: string }).assetId]!;
    const buf = audioBufferFor(asset);
    if (!buf) continue;
    try {
      out.push({ ...p, buffer: await buf });
    } catch (e) {
      window.be.app.log(`audio: couldn't decode ${asset.name}: ${String(e)}`);
    }
  }
  return out;
};

/** Schedule the show's sound for [from, to) into any audio context, starting at context time `at`. */
const schedule = (ctx: BaseAudioContext, dest: AudioNode, items: Mixable[], from: Flicks, to: Flicks, at: number): AudioScheduledSourceNode[] => {
  const nodes: AudioScheduledSourceNode[] = [];
  for (const item of items) {
    const { layer, buffer } = item;
    if (layer.stretch <= 0) continue; // reversed sound isn't supported yet; picture still plays
    const local = (t: Flicks) => item.a * t + item.b;
    const rate = Math.abs(layer.stretch) * item.a;
    const ws = Math.max(item.from, from);
    const we = Math.min(item.to, to);
    if (we <= ws) continue;
    const offset = ((local(ws) - layer.startTime) / F) * Math.abs(layer.stretch);
    if (offset >= buffer.duration) continue;
    const when = at + (ws - from) / F;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    const a = layer.audio;
    // Automation sampled at 50 Hz: volume keyframes × fades × containers; pan keyframes.
    const step = F / 50;
    const fadeIn = (a?.fadeIn ?? 0) * F;
    const fadeOut = (a?.fadeOut ?? 0) * F;
    const g = (t: Flicks) => {
      const lt = local(t);
      let v = a ? dbToGain(evalProp(a.volume, lt)) : 1;
      if (fadeIn > 0 && lt < layer.inPoint + fadeIn) v *= Math.max(0, (lt - layer.inPoint) / fadeIn);
      if (fadeOut > 0 && lt > layer.outPoint - fadeOut) v *= Math.max(0, (layer.outPoint - lt) / fadeOut);
      return v * item.outer(t);
    };
    // Nested sound always follows its containers (e.g. a crossfade), so it's sampled too.
    const animated = (a?.volume.keyframes?.length ?? 0) > 0 || fadeIn > 0 || fadeOut > 0 || item.a !== 1 || item.b !== 0 || item.outer(ws) !== 1 || item.outer(we) !== 1;
    gain.gain.setValueAtTime(g(ws), when);
    if (animated) for (let t = ws + step; t < we; t += step) gain.gain.linearRampToValueAtTime(g(t), when + (t - ws) / F);
    pan.pan.setValueAtTime(a ? Math.max(-1, Math.min(1, evalProp(a.pan, local(ws)))) : 0, when);
    if ((a?.pan.keyframes?.length ?? 0) > 0) for (let t = ws + step; t < we; t += step) pan.pan.linearRampToValueAtTime(Math.max(-1, Math.min(1, evalProp(a!.pan, local(t)))), when + (t - ws) / F);
    src.connect(gain).connect(pan).connect(dest);
    src.start(Math.max(when, ctx.currentTime), offset, ((we - ws) / F) * rate);
    nodes.push(src);
  }
  return nodes;
};

/** Render the show's sound offline to 48 kHz stereo WAV bytes for [from, to). */
export const mixdownWav = async (project: Project, compId: Id, from: Flicks, to: Flicks): Promise<Uint8Array | null> => {
  const items = await collect(project, compId);
  if (items.length === 0) return null;
  const sr = 48000;
  const frames = Math.max(1, Math.round(((to - from) / F) * sr));
  const ctx = new OfflineAudioContext(2, frames, sr);
  schedule(ctx, ctx.destination, items, from, to, 0);
  const buf = await ctx.startRendering();
  return encodeWav(buf);
};

export const encodeWav = (buf: AudioBuffer): Uint8Array => {
  const ch = 2;
  const n = buf.length;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  out.setUint32(4, 36 + n * ch * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, ch, true);
  out.setUint32(24, buf.sampleRate, true);
  out.setUint32(28, buf.sampleRate * ch * 2, true);
  out.setUint16(32, ch * 2, true);
  out.setUint16(34, 16, true);
  str(36, "data");
  out.setUint32(40, n * ch * 2, true);
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  for (let i = 0, o = 44; i < n; i++, o += 4) {
    out.setInt16(o, Math.max(-1, Math.min(1, L[i]!)) * 0x7fff, true);
    out.setInt16(o + 2, Math.max(-1, Math.min(1, R[i]!)) * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
};

// ---------------------------------------------------------------------------------------------
// Live preview player (editor window only)

class PreviewPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private nodes: AudioScheduledSourceNode[] = [];
  private startT: Flicks = 0;
  private startCtx = 0;
  private running = false;
  /** True while sound is loading for a start; prevents restart storms. */
  starting = false;
  private token = 0;
  private signature = "";

  /** Current show time according to the sound card clock, or null when no sound is playing. */
  now(): Flicks | null {
    if (!this.running || !this.ctx) return null;
    return this.startT + Math.round((this.ctx.currentTime - this.startCtx) * F);
  }

  async start(project: Project, compId: Id, t: Flicks, end: Flicks): Promise<void> {
    this.stop();
    const my = ++this.token;
    if (!hasAudio(project, compId)) return;
    this.starting = true;
    let items: Mixable[];
    try {
      items = await collect(project, compId);
    } finally {
      if (my === this.token) this.starting = false;
    }
    if (my !== this.token || items.length === 0) return;
    this.ctx ??= new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.master ??= this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    // Picture may have moved on while sound was loading; start from the current playhead.
    const cur = useStudio.getState().time;
    const at = this.ctx.currentTime + 0.03;
    this.nodes = schedule(this.ctx, this.master, items, cur, end, at);
    this.startT = cur;
    this.startCtx = at;
    this.running = true;
    this.startCount++;
  }

  private startCount = 0;
  /** Times sound has started playing (each play, and each resync after drifting from the picture). */
  get starts(): number {
    return this.startCount;
  }

  stop(): void {
    this.token++;
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        /* not started */
      }
    }
    this.nodes = [];
    this.running = false;
  }

  /** Restart when audio-relevant parts of the project change during playback. */
  audioSignature(project: Project, compId: Id): string {
    const comp = project.compositions[compId];
    if (!comp) return "";
    return JSON.stringify(placedSounds(project, comp).map(({ layer: l, a, b, from, to }) => [l.id, l.startTime, l.inPoint, l.outPoint, l.stretch, l.audio, a, b, from, to]));
  }

  get isRunning(): boolean {
    return this.running;
  }

  set sig(s: string) {
    this.signature = s;
  }
  get sig(): string {
    return this.signature;
  }
}

export const previewAudio = new PreviewPlayer();

/** Editor only: start/stop sound with playback, follow seeks, loops and edits. */
export const startAudioSync = (): (() => void) => {
  const evaluate = () => {
    const s = useStudio.getState();
    const mode = usePreviewStats.getState().mode;
    const comp = s.project && s.compId ? s.project.compositions[s.compId] : undefined;
    const shouldPlay = s.playing && mode === "playing" && !!comp;
    if (!shouldPlay || !comp || !s.project) {
      if (previewAudio.isRunning) previewAudio.stop();
      return;
    }
    const end = s.range?.end ?? comp.duration;
    const sig = previewAudio.audioSignature(s.project, comp.id);
    if (!hasAudio(s.project, comp.id)) {
      if (previewAudio.isRunning) previewAudio.stop();
      return;
    }
    if (previewAudio.starting && sig === previewAudio.sig) return;
    const now = previewAudio.now();
    const drift = now === null ? Infinity : Math.abs(now - s.time);
    if (!previewAudio.isRunning || drift > F * 0.15 || sig !== previewAudio.sig) {
      previewAudio.sig = sig;
      void previewAudio.start(s.project, comp.id, s.time, end);
    }
  };
  const u1 = useStudio.subscribe(evaluate);
  const u2 = usePreviewStats.subscribe(evaluate);
  return () => {
    u1();
    u2();
    previewAudio.stop();
  };
};
