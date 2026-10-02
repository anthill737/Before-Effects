/**
 * The preview panel: large, central, and the same in the editor and the pop-out window.
 *
 *   Views:      Show preview · 3D projection preview · Projector output preview
 *   Size:       Auto / Full / Half / Quarter / Eighth / Custom (rendered pixels, always shown)
 *   Zoom:       Fit / 25–400 %. Display only; it never changes the rendered pixels.
 *   Transport:  restart, step, play/pause, loop, preview range
 *   Status:     target vs achieved fps, skipped frames, cache, preparing progress
 */
import { formatSecondsFriendly, formatTimecode, type Project } from "@be/core";
import { DEFAULT_ORBIT } from "@be/engine";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { previewAudio } from "../studio/audioEngine.ts";
import { getMediaHost, getRenderer, venueReference } from "../studio/engineHost.ts";
import { activeVenue, useStudio } from "../studio/store.ts";
import { PreviewLoop, type PreviewSource, usePreviewStats } from "./loop.ts";
import { venuePhotoUrl } from "../space/actions.ts";
import { TracingLayer } from "../space/TracingLayer.tsx";
import { useTrace } from "../space/traceStore.ts";
import { ActionBar, CalibrationOverlay, RegionOverlay } from "./overlays.tsx";
import { effectiveFraction, fractionLabel, RESOLUTIONS, type ResolutionChoice, usePreview, type View } from "./settings.ts";
import { onSimFrame, simProgress, useSims } from "../studio/simHost.ts";
import { dropOnArea, isContentDrag, readDragPayload } from "../studio/assign.ts";
import { areaAt } from "../space/areaEdit.ts";

const VIEWS: Array<{ id: View; label: string; hint: string }> = [
  { id: "show", label: "Show preview", hint: "The show exactly as it will be exported (projected light only)" },
  { id: "venue", label: "On the house", hint: "Simulated: your content lit onto the house photo, as the audience would see it. The photo is never exported or sent to the projector." },
  { id: "3d", label: "3D projection", hint: "Your content on the building — drag to orbit, right-drag to pan, wheel to zoom" },
  { id: "projector", label: "Projector output", hint: "The image the projector will output, with its alignment and output corrections" },
];

const ZOOMS = [0.25, 0.5, 1, 2, 4];

let activeLoop: PreviewLoop | null = null;
/** The editor's loop, so edits can invalidate exactly the frames they change. */
export const currentPreviewLoop = () => activeLoop;

export interface PreviewPanelProps {
  readonly role: "editor" | "popout";
  readonly source: PreviewSource;
  /** Follower windows get the project and the venue reference from sync. */
  readonly projectOverride?: Project | null;
}

/** While a smoke or water simulation is being prepared, say so (and how far it is). */
const SimChip = () => {
  const p = simProgress(useSims((s) => s.status));
  if (!p || p.done >= p.total) return null;
  return (
    <span className="preparing" title="Simulations are prepared once, then play smoothly; preview and export use the same frames.">
      Simulating {Math.round((p.done / Math.max(1, p.total)) * 100)}%
      <progress max={p.total} value={p.done} />
    </span>
  );
};

export const PreviewPanel = ({ role, source }: PreviewPanelProps) => {
  const s = usePreview();
  const project = useStudio((st) => st.project);
  const compId = useStudio((st) => st.compId);
  const comp = project && compId ? project.compositions[compId] : undefined;
  const venue = project ? activeVenue({ project }) : undefined;
  const projector = venue?.projectorOrder[0] ? venue.projectors[venue.projectorOrder[0]] : undefined;
  const [poppedOut, setPoppedOut] = useState(false);
  const step = useStudio((st) => st.step);
  const photoOpacity = useTrace((t) => t.photoOpacity);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const tracing = role === "editor" && step === "space" && s.view === "show";
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dropArea, setDropArea] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loopRef = useRef<PreviewLoop | null>(null);
  const [box, setBox] = useState({ w: 800, h: 450 });
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e!.contentRect.width, h: e!.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (role !== "editor") return;
    return window.be.windows.onWindowsChanged((w) => setPoppedOut(w.preview));
  }, [role]);

  // Create the render loop once per canvas.
  useEffect(() => {
    let disposed = false;
    let loop: PreviewLoop | null = null;
    let offMedia: (() => void) | null = null;
    let offSims: (() => void) | null = null;
    (async () => {
      try {
        const r = await getRenderer();
        if (disposed || !canvasRef.current) return;
        loop = new PreviewLoop(r, canvasRef.current, source, () => {
          const el = wrapRef.current;
          return { width: el?.clientWidth ?? 800, height: el?.clientHeight ?? 450 };
        });
        loopRef.current = loop;
        activeLoop = loop;
        offMedia = getMediaHost()?.onLoaded(() => loop?.invalidateView()) ?? null;
        offSims = onSimFrame(() => loop?.invalidateView());
        loop.start();
      } catch (e) {
        setError(String((e as { userMessage?: string }).userMessage ?? e));
      }
    })();
    return () => {
      disposed = true;
      offMedia?.();
      offSims?.();
      loop?.stop();
      if (activeLoop === loop) activeLoop = null;
    };
  }, [source, role]);

  // Venue surface colour for the 3D view.
  useEffect(() => {
    let cancelled = false;
    if (!project) return;
    void venueReference(project).then((tex) => {
      if (!cancelled && loopRef.current) {
        loopRef.current.reference = tex;
        loopRef.current.invalidateView();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [project?.activeVenueId, venue?.referenceAssetId]);

  useEffect(() => loopRef.current?.cache.setBudget(s.cacheBudgetMB * 1024 * 1024), [s.cacheBudgetMB]);

  // Ctrl+wheel zooms the picture around the pointer (display zoom only: never changes the rendered pixels).
  const zoomAnchor = useRef<{ fx: number; fy: number; cx: number; cy: number } | null>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || role !== "editor") return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || usePreview.getState().view === "3d") return;
      e.preventDefault();
      const st = usePreview.getState();
      const canvasEl = el.querySelector<HTMLElement>(".canvas-stage");
      const rect = canvasEl?.getBoundingClientRect();
      const p = useStudio.getState().project;
      const c = p && useStudio.getState().compId ? p.compositions[useStudio.getState().compId!] : undefined;
      if (!rect || !c) return;
      const dpr = window.devicePixelRatio || 1;
      const current = st.zoom === "fit" ? (rect.width * dpr) / c.width : st.zoom;
      const next = Math.max(0.1, Math.min(8, current * (e.deltaY < 0 ? 1.25 : 0.8)));
      const box = el.getBoundingClientRect();
      zoomAnchor.current = { fx: (e.clientX - rect.left) / rect.width, fy: (e.clientY - rect.top) / rect.height, cx: e.clientX - box.left, cy: e.clientY - box.top };
      st.set({ zoom: Math.round(next * 1000) / 1000 });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [role]);
  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    const el = wrapRef.current;
    const canvasEl = el?.querySelector<HTMLElement>(".canvas-stage");
    if (!a || !el || !canvasEl) return;
    zoomAnchor.current = null;
    // Keep the point under the pointer where it was.
    const r = canvasEl.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    el.scrollLeft += r.left - box.left + a.fx * r.width - a.cx;
    el.scrollTop += r.top - box.top + a.fy * r.height - a.cy;
  });

  // While setting up the space, show the photo under the light so parts can be traced.
  useEffect(() => {
    let cancelled = false;
    if (!tracing || !project) return;
    void venuePhotoUrl(project).then((u) => !cancelled && setPhotoUrl(u));
    return () => {
      cancelled = true;
    };
  }, [tracing, project?.activeVenueId, venue?.referenceAssetId]);

  if (error) {
    return (
      <div className="preview-panel">
        <div className="canvas-error" role="alert">
          <strong>The preview couldn’t start.</strong>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  const out = s.view === "projector" && projector ? { w: projector.output.width, h: projector.output.height } : comp ? { w: comp.width, h: comp.height } : { w: 1920, h: 1080 };
  const aspect = out.w / out.h;
  const dpr = window.devicePixelRatio || 1;
  let stage: { w: number; h: number };
  if (s.view === "3d") stage = { w: Math.max(1, Math.floor(box.w)), h: Math.max(1, Math.floor(box.h)) };
  else if (s.zoom === "fit") {
    const w = Math.min(box.w - 16, (box.h - 16) * aspect);
    stage = { w: Math.max(1, Math.floor(w)), h: Math.max(1, Math.floor(w / aspect)) };
  } else stage = { w: Math.round((out.w * s.zoom) / dpr), h: Math.round((out.h * s.zoom) / dpr) };

  return (
    <div className={`preview-panel ${s.view === "3d" ? "is-3d" : ""}`}>
      <PreviewToolbar role={role} hasProjector={!!projector} onPopOut={() => void window.be.windows.openPreview()} />
      <div className={`preview-scroll ${s.zoom !== "fit" && s.view !== "3d" ? "zoomed" : ""}`} ref={wrapRef} onClick={() => role === "editor" && useStudio.getState().selectRegions([])}>
        {poppedOut && role === "editor" && (
          <div className="popped-note">
            <p>The preview is open in its own window.</p>
            <button className="ghost" onClick={() => void window.be.windows.closePreview()}>
              Bring it back here
            </button>
          </div>
        )}
        <div
          className={`canvas-stage ${dropArea ? "drop-active" : ""}`}
          style={{ width: stage.w, height: stage.h, display: poppedOut && role === "editor" ? "none" : undefined }}
          onDragOver={(e) => {
            if (role !== "editor" || s.view !== "show" || !venue || !isContentDrag(e.dataTransfer)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            const r = e.currentTarget.getBoundingClientRect();
            const area = areaAt([((e.clientX - r.left) / r.width) * venue.canvas.width, ((e.clientY - r.top) / r.height) * venue.canvas.height]);
            if ((area?.id ?? null) !== dropArea) {
              setDropArea(area?.id ?? null);
              useStudio.getState().setHover(area?.id ?? null);
            }
          }}
          onDragLeave={() => {
            setDropArea(null);
            useStudio.getState().setHover(null);
          }}
          onDrop={(e) => {
            const payload = readDragPayload(e.dataTransfer);
            const target = dropArea;
            setDropArea(null);
            useStudio.getState().setHover(null);
            if (!payload || !target) {
              if (payload) useStudio.getState().toast({ kind: "info", text: "Drop it onto one of the areas you traced (outlined when you hover over them)." });
              return;
            }
            e.preventDefault();
            void dropOnArea(payload, target, { x: e.clientX, y: e.clientY });
          }}
        >
          {tracing && photoUrl && <img className="photo-underlay" src={photoUrl} alt="" style={{ width: stage.w, height: stage.h, opacity: photoOpacity }} />}
          <canvas
            ref={canvasRef}
            style={{ width: stage.w, height: stage.h, imageRendering: s.zoom !== "fit" && s.zoom >= 2 ? "pixelated" : "auto", mixBlendMode: tracing && photoUrl ? "screen" : undefined }}
            aria-label={VIEWS.find((v) => v.id === s.view)?.label}
          />
          {(s.view === "show" || s.view === "venue") && venue && <RegionOverlay size={stage} interactive={role === "editor"} />}
          {tracing && <TracingLayer size={stage} />}
          {(s.view === "show" || s.view === "venue") && venue && role === "editor" && !tracing && <ActionBar size={stage} />}
          {s.view === "projector" && projector && role === "editor" && <CalibrationOverlay size={stage} />}
          {s.view === "3d" && <OrbitControls />}
          {s.view === "projector" && !projector && <div className="canvas-note">Add a projector in “Areas” to see its output.</div>}
        </div>
      </div>
      <TransportBar role={role} />
      <StatusLine />
    </div>
  );
};

/** Mouse orbit / pan / zoom for the 3D view. */
const OrbitControls = () => {
  const drag = useRef<{ x: number; y: number; button: number } | null>(null);
  return (
    <div
      className="orbit-layer"
      onPointerDown={(e) => {
        try {
          (e.target as Element).setPointerCapture(e.pointerId);
        } catch {
          /* no active pointer (synthetic events) */
        }
        drag.current = { x: e.clientX, y: e.clientY, button: e.button === 2 || e.shiftKey ? 2 : 0 };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        d.x = e.clientX;
        d.y = e.clientY;
        const o = usePreview.getState().orbit;
        if (d.button === 2) usePreview.getState().set({ orbit: { ...o, panX: o.panX - dx * 0.002 * o.distance, panY: o.panY + dy * 0.002 * o.distance } });
        else usePreview.getState().set({ orbit: { ...o, yaw: o.yaw - dx * 0.3, pitch: Math.max(-5, Math.min(85, o.pitch + dy * 0.3)) } });
      }}
      onPointerUp={() => (drag.current = null)}
      onContextMenu={(e) => e.preventDefault()}
      onWheel={(e) => {
        const o = usePreview.getState().orbit;
        usePreview.getState().set({ orbit: { ...o, distance: Math.max(0.3, Math.min(6, o.distance * Math.exp(e.deltaY * 0.001))) } });
      }}
      onDoubleClick={() => usePreview.getState().set({ orbit: DEFAULT_ORBIT })}
      aria-label="3D view: drag to orbit, right-drag to pan, wheel to zoom, double-click to reset"
      role="application"
    />
  );
};

const PreviewToolbar = ({ role, hasProjector, onPopOut }: { role: "editor" | "popout"; hasProjector: boolean; onPopOut: () => void }) => {
  const s = usePreview();
  const stats = usePreviewStats();
  const [open, setOpen] = useState<"overlays" | "quality" | null>(null);
  const setView = (view: View) => {
    s.set({ view });
    if (role === "editor") window.be.windows.setPreviewView(view);
  };
  const size = stats.size;
  const autoNote = s.resolution === "auto" ? ` (${fractionLabel(stats.fraction)})` : "";
  return (
    <div className="preview-toolbar" role="toolbar" aria-label="Preview controls">
      <div className="segmented" role="radiogroup" aria-label="Preview view">
        {VIEWS.map((v) => (
          <button key={v.id} role="radio" aria-checked={s.view === v.id} className={s.view === v.id ? "on" : ""} title={v.hint} disabled={v.id === "projector" && !hasProjector} onClick={() => setView(v.id)}>
            {v.label}
          </button>
        ))}
      </div>
      <label className="tool-field" title="How many pixels the preview renders. Exports always use full size and quality.">
        <span>Preview size</span>
        <select value={s.resolution} onChange={(e) => s.set({ resolution: e.target.value as ResolutionChoice, autoFraction: 1 })} aria-label="Preview size">
          {RESOLUTIONS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        {s.resolution === "custom" && (
          <input
            className="custom-scale"
            type="number"
            min={5}
            max={100}
            step={5}
            value={Math.round(s.customScale * 100)}
            onChange={(e) => s.set({ customScale: Math.min(1, Math.max(0.05, Number(e.target.value) / 100)) })}
            aria-label="Custom preview scale in percent"
          />
        )}
        <span className="dims" aria-live="polite">
          {size ? `${size.width}×${size.height}${autoNote}` : ""}
          {size?.limitedBy ? ` — reduced by ${size.limitedBy}` : ""}
        </span>
      </label>
      {s.view !== "3d" ? (
        <label className="tool-field" title="Display zoom only — never changes the rendered pixels">
          <span>Zoom</span>
          <select value={s.zoom === "fit" ? "fit" : String(s.zoom)} onChange={(e) => s.set({ zoom: e.target.value === "fit" ? "fit" : Number(e.target.value) })} aria-label="Zoom">
            <option value="fit">Fit</option>
            {s.zoom !== "fit" && !ZOOMS.includes(s.zoom) && <option value={String(s.zoom)}>{Math.round(s.zoom * 100)}%</option>}
            {ZOOMS.map((z) => (
              <option key={z} value={z}>
                {z * 100}%
              </option>
            ))}
          </select>
        </label>
      ) : (
        <button className="ghost small-btn" onClick={() => s.set({ orbit: DEFAULT_ORBIT })} title="Reset the 3D camera (or double-click the view)">
          Reset view
        </button>
      )}
      <div className="tool-pop">
        <button className="ghost small-btn" aria-expanded={open === "overlays"} onClick={() => setOpen(open === "overlays" ? null : "overlays")}>
          Overlays ▾
        </button>
        {open === "overlays" && (
          <div className="popover" role="dialog" aria-label="Overlays">
            {(
              [
                ["outlines", "Surface outlines"],
                ["selection", "Selection"],
                ["guides", "Safe-area guides"],
                ["grid", "Alignment grid (projector view)"],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="check">
                <input type="checkbox" checked={s.overlays[k]} onChange={(e) => s.set({ overlays: { ...s.overlays, [k]: e.target.checked } })} /> {label}
              </label>
            ))}
            <p className="muted small">Overlays never appear in exported files.</p>
          </div>
        )}
      </div>
      <div className="tool-pop">
        <button className="ghost small-btn" aria-expanded={open === "quality"} onClick={() => setOpen(open === "quality" ? null : "quality")}>
          Quality & speed ▾
        </button>
        {open === "quality" && <QualityPopover />}
      </div>
      <div className="grow" />
      {role === "editor" && (
        <>
          <button className="ghost small-btn" onClick={() => s.set({ maximized: !s.maximized })} title="Enlarge the preview (keeps the timeline and controls)" aria-pressed={s.maximized}>
            {s.maximized ? "⤡ Restore" : "⤢ Enlarge"}
          </button>
          <button className="ghost small-btn" onClick={onPopOut} title="Move the preview into its own window, e.g. on another display">
            ⧉ Pop out
          </button>
        </>
      )}
      {role === "popout" && (
        <button className="ghost small-btn" onClick={() => (document.fullscreenElement ? void document.exitFullscreen() : void document.documentElement.requestFullscreen())}>
          ⛶ Full screen
        </button>
      )}
    </div>
  );
};

const QualityPopover = () => {
  const s = usePreview();
  return (
    <div className="popover wide" role="dialog" aria-label="Quality and speed">
      <p className="muted small">These only affect the preview. Exports always render at full size and full quality.</p>
      <label className="row-field">
        <span>Playback</span>
        <select value={s.playbackMode} onChange={(e) => s.set({ playbackMode: e.target.value as "realtime" | "cache" })}>
          <option value="realtime">Real time (skips frames if needed)</option>
          <option value="cache">Smooth — prepare frames first</option>
        </select>
      </label>
      <label className="row-field">
        <span>Effect quality</span>
        <select value={s.effectQuality} onChange={(e) => s.set({ effectQuality: e.target.value as "full" | "draft" })}>
          <option value="full">Full</option>
          <option value="draft">Draft (faster blurs and glows)</option>
        </select>
      </label>
      <label className="row-field">
        <span>Simulation quality</span>
        <select value={s.simQuality} onChange={(e) => s.set({ simQuality: e.target.value as "full" | "draft" })}>
          <option value="full">Full</option>
          <option value="draft">Draft</option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={s.frameSkipping} onChange={(e) => s.set({ frameSkipping: e.target.checked })} /> Skip frames to keep real-time timing
      </label>
      <label className="check">
        <input type="checkbox" checked={s.useProxies} onChange={(e) => s.set({ useProxies: e.target.checked })} /> Use lighter proxy copies of videos for preview
      </label>
      <label className="row-field">
        <span>Frame cache</span>
        <select value={s.cacheBudgetMB} onChange={(e) => s.set({ cacheBudgetMB: Number(e.target.value) })}>
          {[512, 1024, 1536, 3072, 6144].map((m) => (
            <option key={m} value={m}>
              {m >= 1024 ? `${m / 1024} GB` : `${m} MB`} of graphics memory
            </option>
          ))}
        </select>
      </label>
      <div className="row gap">
        <button className="ghost small-btn" onClick={() => currentPreviewLoop()?.cache.clear()}>
          Clear cached frames
        </button>
        <button className="ghost small-btn" onClick={() => s.reset()}>
          Reset preview settings
        </button>
      </div>
    </div>
  );
};

const TransportBar = ({ role }: { role: "editor" | "popout" }) => {
  const time = useStudio((st) => st.time);
  const playing = useStudio((st) => st.playing);
  const loop = useStudio((st) => st.loop);
  const range = useStudio((st) => st.range);
  const project = useStudio((st) => st.project);
  const compId = useStudio((st) => st.compId);
  const comp = project && compId ? project.compositions[compId] : undefined;
  const st = useStudio.getState();
  if (!comp) return null;
  return (
    <div className="transport" role="toolbar" aria-label="Playback">
      <button className="icon" onClick={() => st.restart()} title="Back to start (Home)" aria-label="Back to start">
        ⏮
      </button>
      <button className="icon" onClick={() => st.stepFrames(-1)} title="Previous frame (←)" aria-label="Previous frame">
        ◀︎❘
      </button>
      <button className="play" onClick={() => st.setPlaying(!playing)} title={playing ? "Pause (Space)" : "Play (Space)"} aria-label={playing ? "Pause" : "Play"}>
        {playing ? "❚❚" : "▶"}
      </button>
      <button className="icon" onClick={() => st.stepFrames(1)} title="Next frame (→)" aria-label="Next frame">
        ❘▶︎
      </button>
      <button className={`icon ${loop ? "on" : ""}`} onClick={() => st.setLoop(!loop)} aria-pressed={loop} title="Loop playback (L)" aria-label="Loop">
        ⟲
      </button>
      <span className="timecode" title={formatTimecode(time, comp.frameRate)}>
        {formatTimecode(time, comp.frameRate)} <span className="muted">· {formatSecondsFriendly(time)} / {formatSecondsFriendly(comp.duration)}</span>
      </span>
      {role === "editor" && (
        <span className="range-tools">
          <button className="ghost small-btn" onClick={() => st.setRange({ start: useStudio.getState().time, end: useStudio.getState().range?.end ?? comp.duration })} title="Start the preview range here (I)">
            Range start
          </button>
          <button className="ghost small-btn" onClick={() => st.setRange({ start: useStudio.getState().range?.start ?? 0, end: useStudio.getState().time })} title="End the preview range here (O)">
            Range end
          </button>
          {range && (
            <button className="link" onClick={() => st.setRange(null)}>
              Whole show
            </button>
          )}
          <span className="muted small">{range ? `${formatSecondsFriendly(range.start)}–${formatSecondsFriendly(range.end)}` : "Range: whole show"}</span>
        </span>
      )}
    </div>
  );
};

const StatusLine = () => {
  const st = usePreviewStats();
  const s = usePreview();
  const fraction = effectiveFraction(s);
  const behind = st.mode === "playing" && st.achievedFps > 0 && st.achievedFps < st.targetFps * 0.8;
  return (
    <div className="preview-status" aria-live="polite">
      {st.size && (
        <span>
          {s.resolution === "auto" ? "Auto" : RESOLUTIONS.find((r) => r.id === s.resolution)?.label} · {st.size.width}×{st.size.height}
          {st.size.width !== st.size.fullWidth ? ` of ${st.size.fullWidth}×${st.size.fullHeight}` : ""}
          {s.effectQuality === "draft" ? " · Draft effects" : ""}
        </span>
      )}
      {st.mode === "preparing" && st.preparing && (
        <span className="preparing">
          Preparing frames for smooth playback {st.preparing.done} / {st.preparing.total}
          <progress max={st.preparing.total} value={st.preparing.done} />
        </span>
      )}
      {st.mode === "playing" && (
        <span className={behind ? "warn" : ""}>
          {st.achievedFps} / {Math.round(st.targetFps * 100) / 100} fps{st.dropped ? ` · ${st.dropped} frames skipped` : ""}
          {st.everyFrame ? " · playing every frame (slower than real time)" : ""}
        </span>
      )}
      <SimChip />
      <span className="muted">
        Cache {st.cacheFrames} frames · {st.cacheMB} MB of {st.cacheBudgetMB >= 1024 ? `${(st.cacheBudgetMB / 1024).toFixed(1)} GB` : `${st.cacheBudgetMB} MB`}
      </span>
      {behind && s.resolution !== "auto" && (
        <span className="offer">
          Dropping frames.{" "}
          <button className="link" onClick={() => s.set({ playbackMode: "cache" })}>
            Prepare for smooth playback
          </button>{" "}
          {fraction > 1 / 8 && (
            <>
              or{" "}
              <button className="link" onClick={() => s.set({ resolution: fraction > 0.5 ? "half" : fraction > 0.25 ? "quarter" : "eighth" })}>
                use a smaller preview size
              </button>
            </>
          )}
        </span>
      )}
    </div>
  );
};

/** Editor-side source: the studio store owns the clock. */
export const editorSource: PreviewSource = {
  project: () => {
    const s = useStudio.getState();
    return s.hoverPreview ?? s.project;
  },
  compId: () => useStudio.getState().compId,
  time: () => useStudio.getState().time,
  playing: () => useStudio.getState().playing,
  setTime: (t) => useStudio.setState({ time: t }),
  range: () => useStudio.getState().range,
  loop: () => useStudio.getState().loop,
  setPlaying: (p) => useStudio.getState().setPlaying(p),
  cacheable: () => !useStudio.getState().hoverPreview,
  clock: () => (window.be.app.kind === "editor" || window.be.app.kind === "uitest" ? previewAudio.now() : null),
};
