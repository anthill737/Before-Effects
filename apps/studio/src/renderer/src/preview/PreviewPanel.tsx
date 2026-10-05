/**
 * The preview panel: large, central, and the same in the editor and the pop-out window.
 *
 *   Views:      Show preview · 3D projection preview · Projector output preview
 *   Size:       Auto / Full / Half / Quarter / Eighth / Custom (rendered pixels, always shown)
 *   Zoom:       Fit / 25–400 %. Display only; it never changes the rendered pixels.
 *   Transport:  restart, step, play/pause, loop, preview range
 *   Status:     target vs achieved fps, skipped frames, cache (memory and disk), preparing progress
 *   Caches:     any amount of graphics memory for frames and video, and disk space for frames
 *               (Quality & speed), with what this computer has for guidance
 */
import { formatSecondsFriendly, formatTimecode, type Project } from "@be/core";
import { DEFAULT_ORBIT } from "@be/engine";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MachineMemory } from "../../../shared/api.ts";
import { formatSize } from "../../../shared/diskFrames.ts";
import { clearDiskCache, refreshDiskStatus, useDiskCache } from "./diskCache.ts";
import { touched } from "./activity.ts";
import { pausePreparing, type PrepareJob, type PrepareTarget, startPreparing, stopPreparing, usePrepare } from "./prepare.ts";
import type { PlanResolution } from "../../../shared/cachePlan.ts";
import { applyPlan, matchesPlan, useCachePlan } from "./recommend.ts";
import { previewAudio } from "../studio/audioEngine.ts";
import { followerClock, followersReady } from "./sync.ts";
import { getMediaHost, getRenderer, venueReference } from "../studio/engineHost.ts";
import { activeVenue, useStudio } from "../studio/store.ts";
import { currentProjector, useCurrentProjector, useProjectorPick } from "../studio/projectors.ts";
import { publishMirror } from "./mirror.ts";
import { PreviewLoop, type PreviewSource, usePreviewStats } from "./loop.ts";
import { venuePhotoUrl } from "../space/actions.ts";
import { TracingLayer } from "../space/TracingLayer.tsx";
import { useTrace } from "../space/traceStore.ts";
import { ActionBar, CalibrationOverlay, RegionOverlay } from "./overlays.tsx";
import { effectiveFraction, fractionLabel, MIN_DISK_GB, MIN_MEMORY_MB, RESOLUTIONS, type PreviewSettings, type ResolutionChoice, usePreview, type View } from "./settings.ts";
import { onSimFrame, simProgress, useSims } from "../studio/simHost.ts";
import { dropOnArea, isContentDrag, readDragPayload } from "../studio/assign.ts";
import { areaAt } from "../space/areaEdit.ts";

const VIEWS: Array<{ id: View; label: string; hint: string }> = [
  { id: "show", label: "Show", hint: "The show exactly as it will be exported (projected light only)" },
  { id: "venue", label: "On house", hint: "Simulated: your content lit onto the house photo, as the audience would see it. The photo is never exported or sent to the projector." },
  { id: "3d", label: "3D", hint: "Your content on the building — drag to orbit, right-drag to pan, wheel to zoom" },
  { id: "projector", label: "Projector", hint: "The image the projector will output, with its alignment and output corrections" },
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
  /** Full-screen on a projector: only the picture (and the outlines), no toolbar or transport. */
  readonly clean?: boolean;
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

let previewOnProjectorNow = false;

/**
 * Put the preview on the projector (full-screen there, only the picture) while editing stays on this
 * screen — or take it off again. It goes to the display the current projector was last shown on, else
 * the biggest screen other than the main one.
 */
export const togglePreviewOnProjector = async (): Promise<void> => {
  if (previewOnProjectorNow) return window.be.windows.closePreview();
  const displays = await window.be.displays.list();
  const others = displays.filter((d) => !d.primary);
  if (!others.length) {
    useStudio.getState().toast({ kind: "info", text: "Only this screen is connected. Plug in the projector and press Win+P → Extend, then try again." });
    return;
  }
  const s = useStudio.getState();
  const venue = s.project ? activeVenue({ project: s.project }) : undefined;
  const saved = venue ? currentProjector(venue, useProjectorPick.getState().id)?.output.displayId : undefined;
  const target = others.find((d) => String(d.id) === saved) ?? others.sort((a, b) => b.pixels.width * b.pixels.height - a.pixels.width * a.pixels.height)[0]!;
  await window.be.windows.openPreview(target.id, true);
};

export const PreviewPanel = ({ role, source, clean = false }: PreviewPanelProps) => {
  const s = usePreview();
  const project = useStudio((st) => st.project);
  const compId = useStudio((st) => st.compId);
  const comp = project && compId ? project.compositions[compId] : undefined;
  const venue = project ? activeVenue({ project }) : undefined;
  const projector = useCurrentProjector(venue);
  const [poppedOut, setPoppedOut] = useState(false);
  const [onProjector, setOnProjector] = useState(false);
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
    return window.be.windows.onWindowsChanged((w) => {
      // On a projector the laptop keeps its own preview; a pop-out window on the desktop replaces it.
      setPoppedOut(w.preview && !w.previewOnProjector);
      setOnProjector(!!w.previewOnProjector);
      previewOnProjectorNow = !!w.previewOnProjector;
    });
  }, [role]);

  // While the preview is also open elsewhere, it follows this one's view, overlays and selection.
  useEffect(() => {
    if (role !== "editor" || !(poppedOut || onProjector)) return;
    return publishMirror();
  }, [role, poppedOut, onProjector]);

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

  // A moment's wait, so dragging the slider down and back up doesn't throw frames away on the way.
  useEffect(() => {
    const t = setTimeout(() => loopRef.current?.cache.setBudget(s.cacheBudgetMB * 1024 * 1024), 300);
    return () => clearTimeout(t);
  }, [s.cacheBudgetMB]);

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
  else if (s.zoom === "fit" || clean) {
    const pad = clean ? 0 : 16;
    const w = Math.min(box.w - pad, (box.h - pad) * aspect);
    stage = { w: Math.max(1, Math.floor(w)), h: Math.max(1, Math.floor(w / aspect)) };
  } else stage = { w: Math.round((out.w * s.zoom) / dpr), h: Math.round((out.h * s.zoom) / dpr) };

  return (
    <div className={`preview-panel ${s.view === "3d" ? "is-3d" : ""} ${clean ? "clean" : ""}`}>
      {!clean && <PreviewToolbar role={role} hasProjector={!!projector} onProjector={onProjector} onPopOut={() => void window.be.windows.openPreview()} />}
      <div className={`preview-scroll ${s.zoom !== "fit" && s.view !== "3d" && !clean ? "zoomed" : ""}`} ref={wrapRef} onClick={() => role === "editor" && useStudio.getState().selectRegions([])}>
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
      {!clean && <TransportBar role={role} />}
      {!clean && <StatusLine />}
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

const PreviewToolbar = ({ role, hasProjector, onProjector, onPopOut }: { role: "editor" | "popout"; hasProjector: boolean; onProjector: boolean; onPopOut: () => void }) => {
  const s = usePreview();
  const stats = usePreviewStats();
  const [open, setOpen] = useState<"overlays" | "quality" | "preview" | null>(null);
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
      {role === "editor" && (
        <div className="tool-pop">
          <button className="ghost small-btn" aria-expanded={open === "preview"} onClick={() => setOpen(open === "preview" ? null : "preview")} title="What Play plays and caches, and preparing frames ahead">
            Preview ▾
          </button>
          {open === "preview" && <PreviewPopover />}
        </div>
      )}
      <div className="tool-pop">
        <button className="ghost small-btn" aria-expanded={open === "quality"} onClick={() => setOpen(open === "quality" ? null : "quality")}>
          Quality & speed ▾
        </button>
        {open === "quality" && <QualityPopover />}
      </div>
      <div className="grow" />
      {role === "editor" && (
        <>
          <button className="ghost small-btn" onClick={() => s.set({ maximized: !s.maximized })} title={s.maximized ? "Back to the panels (`)" : "Enlarge the preview — keeps the timeline and controls (`)"} aria-label={s.maximized ? "Restore" : "Enlarge"} aria-pressed={s.maximized}>
            {s.maximized ? "⤡" : "⤢"}
          </button>
          <button
            className={`ghost small-btn ${onProjector ? "on" : ""}`}
            onClick={() => void togglePreviewOnProjector()}
            title={onProjector ? "Take the preview off the projector" : "Show this preview full-screen on the projector, and keep editing here"}
            aria-pressed={onProjector}
          >
            {onProjector ? "■ On projector" : "▶ On projector"}
          </button>
          <button className="ghost small-btn" onClick={onPopOut} title="Pop out: the preview in its own window, e.g. on another display" aria-label="Pop out">
            ⧉
          </button>
          <button className="ghost small-btn" onClick={enterFullScreen} title="Full screen: the preview on the whole screen (Esc to come back; Space plays and pauses)" aria-label="Full screen">
            ⛶
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

const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** How much memory this computer and its graphics card have (asked once per window). */
let machineInfo: Promise<MachineMemory | null> | null = null;
const useMachine = (): MachineMemory | null => {
  const [m, setM] = useState<MachineMemory | null>(null);
  useEffect(() => {
    let live = true;
    void (machineInfo ??= window.be.cache.machine().catch(() => null)).then((v) => live && setM(v));
    return () => {
      live = false;
    };
  }, []);
  return m;
};

/**
 * An amount in gigabytes: a slider over the usual range and a box for any amount, including more
 * than the slider reaches. A typed amount applies on Enter or when leaving the box.
 */
const AmountField = ({ label, gb, min, max, step, title, onChange }: { label: string; gb: number; min: number; max: number; step: number; title: string; onChange: (gb: number) => void }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = Number(draft.replace(",", "."));
    setDraft(null);
    if (Number.isFinite(v) && v > 0) onChange(Math.max(min, v));
  };
  return (
    <div className="amount-field" title={title}>
      <span>{label}</span>
      <input type="range" min={min} max={Math.max(min, max)} step={step} value={Math.min(gb, max)} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
      <input
        className="amount-number"
        type="number"
        min={min}
        step="any"
        value={draft ?? String(Number(gb.toFixed(2)))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setDraft(null);
        }}
        aria-label={`${label} in gigabytes (any amount)`}
      />
      <span className="unit">GB</span>
    </div>
  );
};

const RES_LABEL = { full: "Full", half: "Half", quarter: "Quarter", eighth: "Eighth" } as const;
const clockText = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min${s % 60 >= 1 ? ` ${Math.round(s % 60)} s` : ""}` : `${Math.max(1, Math.round(s))} s`);

/** Start preparing a scene or the show (at the preview's size; Auto uses the recommended size). */
const prepareNow = async (target: PrepareTarget, recommended?: PlanResolution) => {
  const auto = usePreview.getState().resolution === "auto";
  try {
    await startPreparing({ target, raiseDiskLimit: true, ...(auto && recommended ? { resolution: recommended } : {}) });
  } catch (e) {
    usePrepare.setState({ job: null });
    useStudio.getState().toast({ kind: "error", text: String((e as Error)?.message ?? e) });
  }
};

const ACTIVE: ReadonlyArray<PrepareJob["state"]> = ["waiting", "preparing", "checking", "paused"];

/** A preparation job: progress with Pause and Stop while it runs; the outcome (and why) afterwards. */
const PrepareStatus = ({ compact = false }: { compact?: boolean }) => {
  const job = usePrepare((j) => j.job);
  if (!job) return null;
  const active = ACTIVE.includes(job.state);
  const res = RES_LABEL[job.resolution];
  if (active)
    return (
      <span className="preparing prepare-job" title={`Preparing “${job.name}” at ${res} size: every frame rendered once and kept on disk.`}>
        {job.state === "paused" ? "Paused" : job.phase}: “{job.name}” at {res} {job.done.toLocaleString()} / {job.total.toLocaleString()}
        {job.state === "preparing" && job.fps > 0 ? ` · ${job.fps} frames/s` : ""}
        {job.state === "preparing" && job.etaSeconds !== null ? ` · about ${clockText(job.etaSeconds)} left` : ""}
        <progress max={job.total} value={job.done} />
        <button className="link" onClick={() => pausePreparing(job.state !== "paused")}>
          {job.state === "paused" ? "Resume" : "Pause"}
        </button>
        <button className="link" onClick={() => stopPreparing()}>
          Stop
        </button>
      </span>
    );
  if (compact && job.state === "done" && Date.now() - (job.finishedAt ?? 0) > 15_000) return null;
  return (
    <span className={job.state === "done" ? "ok-text prepare-job" : "warn prepare-job"} role={job.state === "failed" ? "alert" : undefined}>
      {job.state === "done" ? `“${job.name}” is prepared at ${res}: it plays smoothly. ` : job.state === "stopped" && !job.reason ? `Stopped preparing “${job.name}” (${job.done.toLocaleString()} of ${job.total.toLocaleString()} frames ready; starting again carries on). ` : ""}
      {job.reason}{" "}
      <button className="link" onClick={() => usePrepare.setState({ job: null })}>
        {compact ? "✕" : "Dismiss"}
      </button>
    </span>
  );
};

/** What this computer suits (one click to use it), and preparing a scene or the whole show. */
const RecommendAndPrepare = () => {
  const ctx = useCachePlan();
  usePreview(); // re-render when settings change (matchesPlan reads them)
  const project = useStudio((st) => st.project);
  const job = usePrepare((j) => j.job);
  const hasShow = !!project && project.compositionOrder.some((id) => project.compositions[id]?.show);
  if (!ctx) return <p className="muted small">Looking at this computer…</p>;
  const { plan } = ctx;
  const same = matchesPlan(plan);
  const res = RES_LABEL[plan.resolution];
  const busy = !!job && ACTIVE.includes(job.state);
  return (
    <div className="recommend">
      <h3>Recommended for this computer</h3>
      <p className="small">
        Frame cache {formatSize(plan.frameCacheMB * MB)} · video frames {formatSize(plan.videoCacheMB * MB)} · disk {plan.diskCacheGB} GB{ctx.space ? ` on ${ctx.space.drive.replace(/\\$/, "")}` : ""} · prepare at {res} size
      </p>
      <details>
        <summary className="small">Why these amounts</summary>
        <ul className="muted small reasons">
          {plan.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </details>
      <div className="row gap wrap">
        <button className={same ? "ghost small-btn" : "primary small-btn"} disabled={same} onClick={() => applyPlan(plan)}>
          {same ? "✓ Using the recommended settings" : "Use these settings"}
        </button>
      </div>
      <h3>Prepare for smooth playback</h3>
      <p className="muted small">Every frame is rendered once and kept on disk, so it plays smoothly, even after restarting. Edits re-prepare only what they change. Exports always render afresh.</p>
      {plan.fits.map((f) => (
        <p key={f.name} className={f.diskFits ? "muted small" : "warn small"}>
          “{f.name}” ({clockText(f.seconds)}) at {res}: {f.frames.toLocaleString()} frames, about {formatSize(f.diskBytes)} on disk{f.diskFits ? "" : ", more than the recommended disk space"}; {f.memorySeconds >= 1 ? `${Math.floor(f.memorySeconds)} s` : "under a second"} of it fits in graphics memory at once.
        </p>
      ))}
      <div className="row gap wrap">
        <button className="ghost small-btn" disabled={busy || !project} onClick={() => void prepareNow("scene", plan.resolution)}>
          Prepare this scene
        </button>
        <button className="ghost small-btn" disabled={busy || !hasShow} title={hasShow ? "Every scene, in show order" : "Assemble a show first (+ Scene menu)"} onClick={() => void prepareNow("show", plan.resolution)}>
          Prepare the whole show
        </button>
      </div>
      <PrepareStatus />
    </div>
  );
};

/** The preview's picture on the whole screen (Esc, or the browser's own exit, comes back). */
export const enterFullScreen = () => {
  const el = document.querySelector<HTMLElement>(".preview-panel .preview-scroll");
  if (el && !document.fullscreenElement) void el.requestFullscreen().catch(() => undefined);
};

/**
 * Play / stop, as Space and the Play button do. Stopping while caching before playback plays what's
 * been cached so far (when that's on) instead of stopping.
 */
export const togglePlay = () => {
  const s = useStudio.getState();
  touched();
  if (s.playing && usePreview.getState().playCachedOnStop && activeLoop?.playCachedFrames()) return;
  s.setPlaying(!s.playing);
};

const RANGES: Array<{ id: PreviewSettings["previewRange"]; label: string; hint: string }> = [
  { id: "workarea-extended", label: "Work area, extended by the playhead", hint: "The preview range (Range start / end); from the playhead when it's outside it" },
  { id: "workarea", label: "Work area", hint: "Only the preview range (Range start / end), or the whole scene when none is set" },
  { id: "entire", label: "Entire duration", hint: "The whole scene" },
  { id: "around", label: "Around the playhead", hint: "A few seconds before and after the playhead" },
];

/** What Play plays and caches (as After Effects' Preview panel), and preparing frames ahead. */
const PreviewPopover = () => {
  const s = usePreview();
  const job = usePrepare((j) => j.job);
  const busy = !!job && ["waiting", "preparing", "checking"].includes(job.state);
  const st = useStudio.getState();
  const comp = st.project && st.compId ? st.project.compositions[st.compId] : undefined;
  const prepareRange = (startSeconds: number, endSeconds: number) => void startPreparing({ target: "scene", raiseDiskLimit: true, range: { startSeconds, endSeconds } }).catch(() => undefined);
  return (
    <div className="popover preview-pop" role="dialog" aria-label="Preview">
      <label className="tool-field">
        <span>Range</span>
        <select value={s.previewRange} onChange={(e) => s.set({ previewRange: e.target.value as PreviewSettings["previewRange"] })} aria-label="Preview range">
          {RANGES.map((r) => (
            <option key={r.id} value={r.id} title={r.hint}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      {s.previewRange === "around" && (
        <div className="row gap">
          <label className="small">
            Before <input className="text-input num" type="number" min={0} max={60} step={0.5} value={s.aroundBefore} onChange={(e) => s.set({ aroundBefore: Math.max(0, Number(e.target.value) || 0) })} aria-label="Seconds before the playhead" /> s
          </label>
          <label className="small">
            After <input className="text-input num" type="number" min={0.5} max={120} step={0.5} value={s.aroundAfter} onChange={(e) => s.set({ aroundAfter: Math.max(0.5, Number(e.target.value) || 0.5) })} aria-label="Seconds after the playhead" /> s
          </label>
        </div>
      )}
      <label className="check" title="Render every frame of the range first, then play it smoothly with sound">
        <input type="checkbox" checked={s.playbackMode === "cache"} onChange={(e) => s.set({ playbackMode: e.target.checked ? "cache" : "realtime" })} /> Cache before playback
      </label>
      <label className="check" title="Pressing Space (or Pause) while it's still caching plays the frames cached so far, from the range's start">
        <input type="checkbox" checked={s.playCachedOnStop} onChange={(e) => s.set({ playCachedOnStop: e.target.checked })} /> If caching, Space plays the cached frames
      </label>
      <label className="check" title="When nothing happens for a moment, frames ahead of the playhead are rendered and kept, so they play at once">
        <input type="checkbox" checked={s.idleCache} onChange={(e) => s.set({ idleCache: e.target.checked })} /> Cache frames when idle, after{" "}
        <input className="text-input num" type="number" min={0.5} max={60} step={0.5} value={s.idleDelaySeconds} onChange={(e) => s.set({ idleDelaySeconds: Math.max(0.5, Number(e.target.value) || 2) })} aria-label="Seconds idle before caching" /> s
      </label>
      <h3>Prepare ahead (kept on disk)</h3>
      <p className="muted small">At the preview size ({RESOLUTIONS.find((r) => r.id === s.resolution)?.label}). Frames already prepared are skipped; playing pauses it.</p>
      <div className="row gap wrap">
        <button className="ghost small-btn" disabled={busy || !st.range} title={st.range ? "The preview range" : "Set Range start / end first"} onClick={() => st.range && prepareRange(st.range.start / 705_600_000, st.range.end / 705_600_000)}>
          Work area
        </button>
        <button
          className="ghost small-btn"
          disabled={busy || !comp}
          onClick={() => {
            const t = useStudio.getState().time / 705_600_000;
            prepareRange(Math.max(0, t - s.aroundBefore), Math.min((comp?.duration ?? 0) / 705_600_000, t + s.aroundAfter));
          }}
        >
          Around the playhead
        </button>
        <button className="ghost small-btn" disabled={busy || !comp} onClick={() => void startPreparing({ target: "scene", raiseDiskLimit: true }).catch(() => undefined)}>
          This scene
        </button>
        <button className="ghost small-btn" disabled={busy || !showCompOf(st.project)} title={showCompOf(st.project) ? "Every scene, in show order" : "Assemble a show first (+ Scene menu)"} onClick={() => void startPreparing({ target: "show", raiseDiskLimit: true }).catch(() => undefined)}>
          Whole show
        </button>
      </div>
      <PrepareStatus />
    </div>
  );
};
const showCompOf = (p: import("@be/core").Project | null) => (p ? p.compositionOrder.some((id) => p.compositions[id]?.show) : false);

/** Whole gigabytes, the way computers and graphics cards are sold ("32 GB", "12 GB"). */
const wholeGB = (bytes: number) => `${Math.max(1, Math.round(bytes / GB))} GB`;

const QualityPopover = () => {
  const s = usePreview();
  const machine = useMachine();
  const disk = useDiskCache((d) => d.status);
  useEffect(() => {
    if (s.diskCache) void refreshDiskStatus();
  }, [s.diskCache, s.diskCacheFolder]);

  // Graphics memory: guidance from what this computer has (a warning, never a limit).
  const vram = machine?.gpu?.bytes ?? 0;
  const ram = machine?.ramBytes ?? 0;
  const memoryMax = vram ? Math.max(4, Math.ceil(vram / GB)) : 16;
  const onCard = (s.cacheBudgetMB + s.videoCacheMB) * MB;
  let memoryNote: { warn: boolean; text: string } | null = null;
  if (vram && onCard > vram) {
    memoryNote = { warn: true, text: `Together that's ${formatSize(onCard)}, more than the graphics card's ${wholeGB(vram)}. Windows lends it the computer's memory instead, which is slower, and if that runs out too, frames can't be kept.` };
  } else if (vram && onCard > vram * 0.75) {
    memoryNote = { warn: false, text: "That's most of the graphics card's memory. Effects, 3D and the display need some too." };
  } else if (!vram && ram && onCard > ram / 2) {
    memoryNote = { warn: true, text: `Together that's ${formatSize(onCard)}, more than this computer can likely give its graphics card (about ${wholeGB(ram / 2)}).` };
  }
  const machineLine = machine
    ? `This computer has ${wholeGB(ram)} of memory${machine.gpu ? `; its graphics card (${machine.gpu.name}) has ${wholeGB(machine.gpu.bytes)} of its own` : ""}. The pop-out preview keeps its own frames.`
    : "";

  // Disk: guidance from the drive's free space.
  const free = disk && !disk.scanning ? disk.freeBytes : null;
  const diskMax = free !== null && disk ? Math.max(10, Math.floor((free + disk.bytes) / GB)) : 200;
  const tooBig = free !== null && disk !== null && s.diskCacheGB * GB > disk.bytes + free;
  const chooseFolder = async () => {
    const dir = await window.be.files.chooseFolder("Choose where to keep preview frames");
    if (dir) s.set({ diskCacheFolder: dir });
  };

  return (
    <div className="popover wide quality" role="dialog" aria-label="Quality and speed">
      <p className="muted small">These only affect the preview. Exports always render at full size and full quality.</p>
      <RecommendAndPrepare />
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
      <h3>Graphics memory</h3>
      <AmountField
        label="Frame cache"
        gb={s.cacheBudgetMB / 1024}
        min={MIN_MEMORY_MB / 1024}
        max={memoryMax}
        step={0.25}
        title="Finished frames kept in graphics memory, ready to play. More memory means more of the show plays smoothly at full size."
        onChange={(gb) => s.set({ cacheBudgetMB: Math.round(gb * 1024) })}
      />
      <AmountField
        label="Video frames"
        gb={s.videoCacheMB / 1024}
        min={MIN_MEMORY_MB / 1024}
        max={memoryMax}
        step={0.25}
        title="Decoded frames of your videos, kept in graphics memory so they play without waiting."
        onChange={(gb) => s.set({ videoCacheMB: Math.round(gb * 1024) })}
      />
      {machineLine && <p className="muted small">{machineLine}</p>}
      {memoryNote && (
        <p className={memoryNote.warn ? "warn small" : "muted small"} role={memoryNote.warn ? "alert" : undefined}>
          {memoryNote.text}
        </p>
      )}
      <h3>Disk</h3>
      <label className="check">
        <input type="checkbox" checked={s.diskCache} onChange={(e) => s.set({ diskCache: e.target.checked })} /> Also keep finished frames on disk, so they don’t have to be prepared again (even after restarting)
      </label>
      {s.diskCache && (
        <>
          <AmountField
            label="Disk space"
            gb={s.diskCacheGB}
            min={MIN_DISK_GB}
            max={diskMax}
            step={1}
            title="How much of the drive preview frames may use. When it's full, the frames used longest ago make room."
            onChange={(gb) => s.set({ diskCacheGB: Math.round(gb * 100) / 100 })}
          />
          <p className="muted small disk-folder" title={disk?.root}>
            Folder: {disk?.root ?? "…"}
          </p>
          <div className="row gap wrap">
            <button className="ghost small-btn" onClick={() => void chooseFolder()}>
              Change folder…
            </button>
            {s.diskCacheFolder && (
              <button className="ghost small-btn" onClick={() => s.set({ diskCacheFolder: null })}>
                Use the standard folder
              </button>
            )}
            <button className="ghost small-btn" disabled={!disk || disk.scanning || disk.files === 0} onClick={() => void clearDiskCache()}>
              Clear disk cache
            </button>
          </div>
          <p className="muted small">
            {!disk || disk.scanning
              ? "Finding the frames already saved there…"
              : `Using ${formatSize(disk.bytes)} of ${formatSize(s.diskCacheGB * GB)} (${disk.files.toLocaleString()} frames)${disk.freeBytes !== null ? ` · ${formatSize(disk.freeBytes)} free on this drive` : ""}`}
          </p>
          {tooBig && (
            <p className="warn small" role="alert">
              That’s more than this drive has free ({formatSize(free ?? 0)}). Frames stop being saved when the drive is nearly full.
            </p>
          )}
          {disk?.problem && (
            <p className="warn small" role="alert">
              {disk.problem}
            </p>
          )}
        </>
      )}
      <div className="row gap">
        <button className="ghost small-btn" onClick={() => currentPreviewLoop()?.cache.clear()}>
          Clear frames in memory
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
      <button className="play" onClick={togglePlay} title={playing ? "Pause (Space)" : "Play (Space)"} aria-label={playing ? "Pause" : "Play"}>
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
  const disk = useDiskCache((d) => d.status);
  const fraction = effectiveFraction(s);
  const behind = st.mode === "playing" && st.achievedFps > 0 && st.achievedFps < st.targetFps * 0.8;
  // Disk usage changes as frames are saved (here or in another window): look now and then.
  useEffect(() => {
    if (!s.diskCache) return;
    void refreshDiskStatus();
    const t = setInterval(() => void refreshDiskStatus(), 3000);
    return () => clearInterval(t);
  }, [s.diskCache, s.diskCacheFolder]);
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
          {st.preparing.kind === "load" ? "Loading cached frames" : "Rendering frames before playback"} {st.preparing.done} / {st.preparing.total}
          <progress max={st.preparing.total} value={st.preparing.done} />
          {st.preparing.kind !== "load" && s.playCachedOnStop ? " · Space plays what's cached" : ""}
        </span>
      )}
      {st.mode === "paused" && st.idle && <span className="muted">Caching while idle: {st.idle.cached} new · {st.idle.ahead} frames ready ahead</span>}
      {st.mode === "playing" && (
        <span className={behind ? "warn" : ""}>
          {st.achievedFps} / {Math.round(st.targetFps * 100) / 100} fps{st.dropped ? ` · ${st.dropped} frames skipped` : ""}
          {st.everyFrame ? " · playing every frame (slower than real time)" : ""}
        </span>
      )}
      <SimChip />
      <PrepareStatus compact />
      {st.size && s.resolution !== "full" && st.size.width === st.size.fullWidth && <span className="muted">playing prepared full-size frames</span>}
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
      <span className="muted status-fill">
        Cache {st.cacheFrames} frames · {formatSize(st.cacheMB * MB)} of {formatSize(st.cacheBudgetMB * MB)}
        {s.diskCache && ` · Disk ${!disk || disk.scanning ? "(looking…)" : `${disk.files.toLocaleString()} frames · ${formatSize(disk.bytes)} of ${formatSize(s.diskCacheGB * GB)}`}`}
      </span>
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
  // The editor: the sound card's clock. Outputs and the pop-out: the editor's clock (followerClock).
  clock: () => (window.be.app.kind === "editor" || window.be.app.kind === "uitest" ? previewAudio.now() : followerClock()),
  soundStarting: () => (window.be.app.kind === "editor" || window.be.app.kind === "uitest") && previewAudio.starting,
  followersReady: () => (window.be.app.kind === "editor" || window.be.app.kind === "uitest" ? followersReady() : true),
};
