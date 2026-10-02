/**
 * Simple timeline: one bar per effect (recipe) or layer, drag to move in time, click to select.
 * Scrub on the ruler. Detailed keyframe and graph editing arrive in milestone C.
 */
import { type Flicks, formatSecondsFriendly, FLICKS_PER_SECOND, type Layer } from "@be/core";
import { useEffect, useRef, useState } from "react";
import { currentPreviewLoop } from "../preview/PreviewPanel.tsx";
import { usePreviewStats } from "../preview/loop.ts";
import { usePreview } from "../preview/settings.ts";
import { toMono, waveformPeaks } from "@be/core";
import { audioBufferFor } from "./media.ts";
import { useStudio } from "./store.ts";
import { ShowArranger } from "./ScenesBar.tsx";
import { BarEdges, Scene3DMarks } from "./TimelineMarks.tsx";

/** Green strip on the ruler: frames ready in the preview cache at the current preview size. */
const CacheStrip = ({ compId, duration, rate }: { compId: string; duration: number; rate: { num: number; den: number } }) => {
  const [, bump] = useState(0);
  const fraction = usePreviewStats((s) => s.fraction);
  const quality = usePreview((s) => s.effectQuality);
  useEffect(() => {
    let raf = 0;
    const off = currentPreviewLoop()?.cache.subscribe(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => bump((n) => n + 1));
    });
    return () => {
      off?.();
      cancelAnimationFrame(raf);
    };
  });
  const loop = currentPreviewLoop();
  if (!loop) return null;
  const frames = [...loop.cache.cachedFrames(compId, fraction, quality, 0, duration, rate)].sort((a, b) => a - b);
  const total = Math.max(1, Math.round((duration * rate.num) / (705_600_000 * rate.den)));
  const runs: Array<[number, number]> = [];
  for (const f of frames) {
    const last = runs.at(-1);
    if (last && f === last[1] + 1) last[1] = f;
    else runs.push([f, f]);
  }
  return (
    <div className="cache-strip" aria-hidden="true">
      {runs.map(([a, b]) => (
        <span key={a} style={{ left: `${(a / total) * 100}%`, width: `${((b - a + 1) / total) * 100}%` }} />
      ))}
    </div>
  );
};

/** Waveform drawn into a track bar (decoded once per file, cached). */
const peaksCache = new Map<string, Float32Array>();
const Waveform = ({ assetId }: { assetId: string }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const project = useStudio((s) => s.project);
  const asset = project?.assets[assetId];
  useEffect(() => {
    if (!asset || !ref.current) return;
    let cancelled = false;
    const draw = (peaks: Float32Array) => {
      const c = ref.current;
      if (!c || cancelled) return;
      const w = (c.width = Math.max(1, c.clientWidth));
      const h = (c.height = Math.max(1, c.clientHeight));
      const g = c.getContext("2d")!;
      g.clearRect(0, 0, w, h);
      g.fillStyle = "#9fd0ff";
      const n = peaks.length / 2;
      for (let x = 0; x < w; x++) {
        const i = Math.floor((x / w) * n);
        const lo = peaks[i * 2]!;
        const hi = peaks[i * 2 + 1]!;
        g.fillRect(x, h / 2 - hi * (h / 2), 1, Math.max(1, (hi - lo) * (h / 2)));
      }
    };
    const cached = peaksCache.get(assetId);
    if (cached) draw(cached);
    else {
      const p = audioBufferFor(asset);
      void p?.then((buf) => {
        const peaks = waveformPeaks(toMono(Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i))), 2000);
        peaksCache.set(assetId, peaks);
        draw(peaks);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [asset?.id]);
  return <canvas ref={ref} className="waveform" aria-hidden="true" />;
};

interface Row {
  readonly key: string;
  readonly label: string;
  readonly start: Flicks;
  readonly end: Flicks;
  readonly recipeId?: string;
  readonly layer?: Layer;
}

export const Timeline = () => {
  const project = useStudio((s) => s.project);
  const compId = useStudio((s) => s.compId);
  const time = useStudio((s) => s.time);
  const range = useStudio((s) => s.range);
  const selected = useStudio((s) => s.selection.recipeId);
  const selectedLayer = useStudio((s) => s.selection.layerId);
  const trackRef = useRef<HTMLDivElement>(null);
  const comp = project && compId ? project.compositions[compId] : undefined;
  if (!project || !comp) return null;
  if (comp.show) return <ShowArranger comp={comp} />;

  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const id of comp.layerOrder) {
    const l = comp.layers[id];
    if (!l) continue;
    const rid = l.generatedBy?.recipeInstanceId;
    if (rid && project.recipes[rid]) {
      if (seen.has(rid)) continue;
      seen.add(rid);
      const inst = project.recipes[rid]!;
      const ls = Object.values(inst.generated).map((x) => comp.layers[x]).filter((x): x is Layer => !!x);
      rows.push({ key: rid, label: inst.label, start: Math.min(...ls.map((x) => x.inPoint)), end: Math.max(...ls.map((x) => x.outPoint)), recipeId: rid });
    } else {
      rows.push({ key: l.id, label: l.name, start: l.inPoint, end: l.outPoint, layer: l });
    }
  }

  const pct = (t: Flicks) => `${(t / comp.duration) * 100}%`;
  const timeAt = (clientX: number): Flicks => {
    const r = trackRef.current!.getBoundingClientRect();
    return Math.round(((clientX - r.left) / r.width) * comp.duration);
  };

  const scrub = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    useStudio.getState().setPlaying(false);
    useStudio.getState().setTime(timeAt(e.clientX));
  };

  const dragBar = (row: Row) => (e: React.PointerEvent) => {
    e.stopPropagation();
    if (row.recipeId) useStudio.getState().selectRecipe(row.recipeId);
    else if (row.layer) useStudio.getState().selectLayer(row.layer.id);
    const startX = e.clientX;
    const width = trackRef.current!.getBoundingClientRect().width;
    const inst = row.recipeId ? project.recipes[row.recipeId] : undefined;
    const origin = inst ? inst.startTime : row.start;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dt = Math.round(((ev.clientX - startX) / width) * comp.duration);
      const fps = comp.frameRate.num / comp.frameRate.den;
      const snapped = Math.round(((origin + dt) / FLICKS_PER_SECOND) * fps) / fps;
      const next = Math.max(0, Math.round(snapped * FLICKS_PER_SECOND));
      if (inst) {
        useStudio.getState().apply({ type: "recipe.update", args: { instanceId: inst.id, startTime: next } }, { label: "Move effect in time", coalesceKey: `move-${inst.id}`, quiet: true });
      } else if (row.layer && !row.layer.locked) {
        const shift = next - row.layer.inPoint;
        useStudio.getState().apply(
          { type: "layer.update", args: { compId: comp.id, layerId: row.layer.id, changes: { startTime: row.layer.startTime + shift, inPoint: row.layer.inPoint + shift, outPoint: row.layer.outPoint + shift } } },
          { label: "Move layer in time", coalesceKey: `move-${row.layer.id}`, quiet: true },
        );
      }
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const ticks = Math.min(40, Math.ceil(comp.duration / FLICKS_PER_SECOND));
  return (
    <section className="timeline" aria-label="Timeline">
      <div className="timeline-head">
        <span className="muted small">Drag a bar to move it, its ends to change its length · ▼▲ collapse and rebuild · ◆ keyframes (click for easing) · click or drag the ruler to jump · I / O set the preview range · green = frames ready</span>
      </div>
      <div className="timeline-grid">
        <div className="labels">
          <div className="ruler-label" />
          {rows.map((r) => (
            <button
              key={r.key}
              className={`track-label ${(r.recipeId && r.recipeId === selected) || (r.layer && r.layer.id === selectedLayer) ? "on" : ""}`}
              onClick={() => (r.recipeId ? useStudio.getState().selectRecipe(r.recipeId) : r.layer && useStudio.getState().selectLayer(r.layer.id))}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="tracks" ref={trackRef}>
          <div className="ruler" onPointerDown={scrub} onPointerMove={(e) => e.buttons && scrub(e)} role="slider" aria-label="Playhead" aria-valuemin={0} aria-valuemax={comp.duration} aria-valuenow={time}>
            {range && <div className="range-band" style={{ left: pct(range.start), width: pct(range.end - range.start) }} />}
            <CacheStrip compId={comp.id} duration={comp.duration} rate={comp.frameRate} />
            {Array.from({ length: ticks + 1 }, (_, i) => (
              <span key={i} className="tick" style={{ left: `${(i / ticks) * 100}%` }}>
                {Math.round((i / ticks) * (comp.duration / FLICKS_PER_SECOND))}s
              </span>
            ))}
          </div>
          {rows.map((r) => (
            <div key={r.key} className="track">
              <div
                className={`bar ${r.recipeId ? "recipe" : r.layer?.source.kind === "audio" ? "sound" : "layer"} ${(r.recipeId && r.recipeId === selected) || (r.layer && r.layer.id === selectedLayer) ? "on" : ""}`}
                style={{ left: pct(r.start), width: pct(Math.max(r.end - r.start, comp.duration / 200)) }}
                onPointerDown={dragBar(r)}
                title={`${r.label}: ${formatSecondsFriendly(r.start)} – ${formatSecondsFriendly(r.end)}`}
              >
                {r.layer && (r.layer.source.kind === "audio" || r.layer.source.kind === "footage") && project.assets[r.layer.source.assetId]?.audioPath !== undefined || r.layer?.source.kind === "audio" ? (
                  <Waveform assetId={(r.layer!.source as { assetId: string }).assetId} />
                ) : null}
                <span>{r.label}</span>
                <BarEdges comp={comp} inst={r.recipeId ? project.recipes[r.recipeId] : undefined} layer={r.layer} timeAt={timeAt} />
              </div>
              {r.layer?.source.kind === "scene3d" && <Scene3DMarks comp={comp} layer={r.layer} pct={pct} timeAt={timeAt} />}
            </div>
          ))}
          <div className="playhead" style={{ left: pct(time) }} />
        </div>
      </div>
    </section>
  );
};
