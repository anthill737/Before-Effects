/**
 * "Auto-align with phone": the screen for camera-assisted projector alignment (workflow in
 * alignSession.ts). Steps: connect the phone, check the view, capture, mark matching points, review,
 * apply; then check or realign later.
 */
import { fitCameraToPhoto, flattenPath, mapPhotoToCamera, type ReferencePair, type Vec2 } from "@be/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { venuePhotoUrl } from "../../space/actions.ts";
import { useStudio } from "../store.ts";
import {
  applyAlignment,
  areasOnCamera,
  cancelAlign,
  capturePatterns,
  checkAlignment,
  checkView,
  closeAlign,
  currentLens,
  pointProblems,
  projectOutlines,
  realign,
  restorePrevious,
  setPairs,
  solve,
  useAlign,
  verify,
} from "./alignSession.ts";

const run = (p: Promise<unknown> | unknown) => {
  if (p instanceof Promise) p.catch(() => {});
};

export const AutoAlign = () => {
  const s = useAlign();
  const project = useStudio((st) => st.project);
  if (!s.open || !project) return null;
  const venue = s.venueId ? project.venues[s.venueId] : undefined;
  const projector = venue && s.projectorId ? venue.projectors[s.projectorId] : undefined;
  if (!venue || !projector) return null;
  const steps: Array<[typeof s.phase, string]> = [
    ["setup", "Connect and place the phone"],
    ["capturing", "Capture the patterns"],
    ["points", "Match a few points"],
    ["review", "Review"],
    ["applied", "Applied — check it"],
  ];
  const at = steps.findIndex(([p]) => p === s.phase);
  return (
    <div className="align-overlay" role="dialog" aria-label="Auto-align with phone">
      <div className="align-dialog">
        <header className="align-head">
          <h2>Auto-align {projector.name} with your phone</h2>
          <ol className="align-steps">
            {steps.map(([p, label], i) => (
              <li key={p} className={i === at ? "on" : i < at ? "done" : ""}>
                {label}
              </li>
            ))}
          </ol>
          <button className="ghost" onClick={closeAlign} aria-label="Close" disabled={!!s.busy && s.phase === "capturing"}>
            ✕
          </button>
        </header>
        {s.error && (
          <p className="warn align-error" role="alert">
            {s.error}
          </p>
        )}
        <div className="align-body">
          {s.phase === "setup" && <Setup />}
          {s.phase === "capturing" && <Capturing />}
          {s.phase === "points" && <Points />}
          {s.phase === "review" && <Review />}
          {s.phase === "applied" && <Applied />}
        </div>
      </div>
    </div>
  );
};

const PhoneState = () => {
  const p = useAlign((s) => s.phone);
  if (!p?.running) return <p className="muted">Starting the phone connection…</p>;
  if (!p.connected) return <p className="warn">{p.message ?? "Waiting for the phone — scan the QR code with its camera app."}</p>;
  const c = p.controls;
  return (
    <div className="small">
      <p className="ok-text">
        Connected: {p.device}
        {p.camera ? ` · camera ${p.camera.width}×${p.camera.height}` : ""}
      </p>
      {p.orientation === "portrait" && <p className="warn">Turn the phone sideways (landscape) so the whole house fits.</p>}
      {c && (
        <p className="muted">
          Exposure {c.exposure ?? "?"} · focus {c.focus ?? "?"} · white balance {c.whiteBalance ?? "?"}
          {c.exposure !== "locked" ? " (the patterns are paired with their opposites, so automatic exposure still works)" : ""}
        </p>
      )}
      {p.wakeLock === "off" && <p className="muted">Keep the phone's screen on during the alignment.</p>}
      {p.message && <p className="warn">{p.message}</p>}
    </div>
  );
};

const LivePreview = () => {
  const pv = useAlign((s) => s.preview);
  const connected = useAlign((s) => s.phone?.connected);
  return <div className="align-live">{pv && connected ? <img src={pv.url} alt="What the phone's camera sees" /> : <p className="muted">The phone's camera view appears here.</p>}</div>;
};

const Setup = () => {
  const s = useAlign();
  return (
    <div className="align-setup">
      <div className="align-col">
        <h3>1. Connect your phone</h3>
        {s.qrSvg ? <div className="align-qr" dangerouslySetInnerHTML={{ __html: s.qrSvg }} /> : <p className="muted">Making the QR code…</p>}
        <ol className="small align-how">
          <li>The phone must be on the same Wi-Fi as this computer.</li>
          <li>Scan the code with the phone's camera and open the link.</li>
          <li>
            The phone warns the connection “isn't private” — this computer made its own certificate. Tap <b>Show details → visit this website</b> (iPhone) or <b>Advanced → Proceed</b> (Android).
          </li>
          <li>
            Tap <b>Start camera</b> and allow the camera.
          </li>
          <li>If Windows asks whether Before Effects may use the network, allow it on private networks.</li>
        </ol>
        <PhoneState />
      </div>
      <div className="align-col grow">
        <h3>2. Place the phone</h3>
        <p className="small">
          On top of or right beside the projector, facing the house, sideways (landscape). It must not move until the alignment is done. The whole lit area should be in view, with some room around it.
        </p>
        <LivePreview />
        <div className="row gap wrap">
          <button className="ghost" disabled={!s.phone?.connected || !!s.busy} onClick={() => run(checkView())}>
            Check the view
          </button>
          <label className="small row gap">
            Pattern brightness
            <input type="range" min={60} max={255} value={s.level} onChange={(e) => useAlign.setState({ level: Number(e.target.value) })} />
          </label>
          <button className="primary" disabled={!s.phone?.connected || !!s.busy} onClick={() => run(capturePatterns())}>
            Start auto-align
          </button>
        </div>
        {s.busy && <p className="muted small">{s.busy}…</p>}
        {s.view && <p className={s.view.ok ? "ok-text small" : "warn small"}>{s.view.message}</p>}
        <p className="muted small">
          Auto-align projects black and white stripes for about half a minute (a slow sequence, no rapid flashing), photographs each, and works out where every part of the projector's picture lands. Then you mark 4–10 matching spots on
          the house photo and the camera picture.
        </p>
      </div>
    </div>
  );
};

const Capturing = () => {
  const s = useAlign();
  return (
    <div className="align-capturing">
      <LivePreview />
      <div>
        <p>{s.busy ?? "Done."}</p>
        {s.progress && (
          <>
            <progress max={s.progress.total} value={s.progress.done} />
            <span className="small muted">
              {" "}
              {s.progress.done} / {s.progress.total} patterns
            </span>
          </>
        )}
        <p className="small muted">Keep the phone and projector still.</p>
        <div className="row gap">
          {s.busy ? (
            <button className="ghost" onClick={cancelAlign}>
              Cancel
            </button>
          ) : (
            <button className="ghost" onClick={() => useAlign.setState({ phase: "setup" })}>
              Back
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------------------------
// Matching points

interface Marker {
  readonly n: number;
  readonly at: Vec2;
  readonly pending?: boolean;
  readonly bad?: boolean;
}

/** An image you can zoom (wheel) and pan (drag, or Space/middle-drag) and click to place points. */
const ZoomImage = ({
  url,
  size,
  markers,
  lines,
  onPick,
  label,
}: {
  url: string | null;
  size: { width: number; height: number };
  markers: readonly Marker[];
  lines: ReadonlyArray<{ points: readonly Vec2[]; color: string }>;
  onPick: (p: Vec2) => void;
  label: string;
}) => {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ s: 0, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  // Fit on first show and when the image changes size.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const s = Math.min(el.clientWidth / size.width, el.clientHeight / size.height);
    setView({ s, x: (el.clientWidth - size.width * s) / 2, y: (el.clientHeight - size.height * s) / 2 });
  }, [size.width, size.height, url]);
  const toImage = (e: { clientX: number; clientY: number }): Vec2 => {
    const r = box.current!.getBoundingClientRect();
    return [(e.clientX - r.left - view.x) / view.s, (e.clientY - r.top - view.y) / view.s];
  };
  const k = view.s || 1;
  return (
    <div
      ref={box}
      className="zoom-image"
      aria-label={label}
      onWheel={(e) => {
        const r = box.current!.getBoundingClientRect();
        const f = e.deltaY < 0 ? 1.25 : 0.8;
        const cx = e.clientX - r.left, cy = e.clientY - r.top;
        setView((v) => ({ s: v.s * f, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f }));
      }}
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture?.(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, moved: e.button !== 0 };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 4) return;
        d.moved = true;
        d.x = e.clientX;
        d.y = e.clientY;
        setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (d && !d.moved && e.button === 0) onPick(toImage(e));
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="zoom-inner" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${k})`, width: size.width, height: size.height }}>
        {url && <img src={url} alt="" draggable={false} style={{ width: size.width, height: size.height }} />}
        <svg width={size.width} height={size.height} viewBox={`0 0 ${size.width} ${size.height}`}>
          {lines.map((l, i) => (
            <polygon key={i} points={l.points.map((p) => p.join(",")).join(" ")} fill="none" stroke={l.color} strokeWidth={1.5 / k} />
          ))}
          {markers.map((m) => (
            <g key={`${m.n}-${m.pending ? "p" : ""}`} transform={`translate(${m.at[0]},${m.at[1]}) scale(${1 / k})`} className={`pick-marker ${m.pending ? "pending" : ""} ${m.bad ? "bad" : ""}`}>
              <circle r={9} />
              <line x1={-14} x2={14} y1={0} y2={0} />
              <line y1={-14} y2={14} x1={0} x2={0} />
              <text x={12} y={-10}>
                {m.n}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
};

const Points = () => {
  const s = useAlign();
  const project = useStudio((st) => st.project)!;
  const venue = project.venues[s.venueId!]!;
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [pending, setPending] = useState<{ photo?: Vec2; camera?: Vec2 }>({});
  useEffect(() => {
    void venuePhotoUrl(project).then(setPhotoUrl);
  }, [project.activeVenueId]);
  const areas = useMemo(
    () =>
      Object.values(venue.regions)
        .filter((r) => r.path.closed)
        .map((r) => ({ id: r.id, name: r.name, polygon: flattenPath(r.path, 8) })),
    [venue.regions],
  );
  // A live fit while marking: the areas drawn on the camera picture, and how well each point agrees.
  const live = useMemo(() => (s.pairs.length >= 4 ? fitCameraToPhoto(s.pairs, currentLens(), areas, { photo: venue.canvas }) : null), [s.pairs, areas, venue.canvas]);
  const camLines = useMemo(() => (live ? areas.map((a) => ({ points: a.polygon.map((q) => mapPhotoToCamera(live, q)).filter((p): p is Vec2 => !!p), color: "#7fd4ff" })).filter((l) => l.points.length >= 3) : []), [live, areas]);
  const looMed = live ? median(live.looError.filter((x): x is number => x != null)) : null;
  const add = (p: { photo?: Vec2; camera?: Vec2 }) => {
    const next = { ...pending, ...p };
    if (next.photo && next.camera) {
      setPairs([...s.pairs, { photo: next.photo, camera: next.camera }]);
      setPending({});
    } else setPending(next);
  };
  const markersOf = (k: "photo" | "camera"): Marker[] => [
    ...s.pairs.map((p, i) => ({ n: i + 1, at: p[k], bad: !!(live?.looError[i] != null && looMed != null && live.looError[i]! > Math.max(6, 3 * looMed)) })),
    ...(pending[k] ? [{ n: s.pairs.length + 1, at: pending[k]!, pending: true }] : []),
  ];
  const problems = pointProblems();
  return (
    <div className="align-points">
      <p className="small">
        Click a sharp, easy-to-find spot on the <b>house photo</b> (a window corner, the door's corner, the roof peak), then the <b>same spot</b> on the <b>camera picture</b>. Mark at least 4, spread over the whole house; then add one or two on
        anything that stands out or sits back (porch columns, a recessed door, a gable). Scroll to zoom, drag to move around.
      </p>
      <div className="align-pair-views">
        <div>
          <h4>House photo {pending.photo && !pending.camera ? "— now click the same spot on the camera picture →" : ""}</h4>
          <ZoomImage url={photoUrl} size={venue.canvas} label="House photo" markers={markersOf("photo")} lines={areas.map((a) => ({ points: a.polygon, color: "#ffc56b" }))} onPick={(p) => add({ photo: p })} />
        </div>
        <div>
          <h4>Camera picture {pending.camera && !pending.photo ? "← now click the same spot on the house photo" : ""}</h4>
          {s.cameraImage ? (
            <ZoomImage url={s.cameraImage.url} size={s.cameraImage} label="Camera picture" markers={markersOf("camera")} lines={camLines} onPick={(p) => add({ camera: p })} />
          ) : (
            <p className="muted">Capture first.</p>
          )}
        </div>
      </div>
      <div className="row gap wrap align-point-list">
        {s.pairs.map((p, i) => (
          <span key={i} className={`chip ${markersOf("photo")[i]?.bad ? "warn" : ""}`}>
            {i + 1}
            {live?.looError[i] != null ? ` · ${live.looError[i]!.toFixed(0)} px` : ""}
            <button className="ghost small-btn" aria-label={`Remove point ${i + 1}`} onClick={() => setPairs(s.pairs.filter((_, j) => j !== i))}>
              ✕
            </button>
          </span>
        ))}
        {pending.photo || pending.camera ? (
          <button className="ghost small-btn" onClick={() => setPending({})}>
            Cancel this point
          </button>
        ) : null}
      </div>
      {live && <p className="small muted">The blue outlines on the camera picture show where the house areas fall with these points ({live.method}). They should sit on the real windows, doors and edges.</p>}
      {problems.length > 0 && <p className="warn small">{problems.join(" ")}</p>}
      <div className="row gap">
        <button className="ghost" onClick={() => useAlign.setState({ phase: "setup" })}>
          Capture again
        </button>
        <button className="primary" disabled={problems.length > 0 || !!s.busy} onClick={() => run(solve())}>
          Calculate the alignment
        </button>
      </div>
    </div>
  );
};

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);

// ---------------------------------------------------------------------------------------------
// Review and after

const Estimate = () => {
  const e = useAlign((s) => s.estimate);
  if (!e) return null;
  return (
    <div className="align-estimate">
      <p className={e.confidence === "high" ? "ok-text" : e.confidence === "medium" ? "" : "warn"}>{e.summary}</p>
      <p className="small muted">
        Measured spots fit to {e.fitPx.median.toFixed(1)} px (95%: {e.fitPx.p95.toFixed(1)} px) · {e.method}
      </p>
      <table className="small align-areas">
        <thead>
          <tr>
            <th>Area</th>
            <th>Seen by camera</th>
            <th>Est. error</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {e.areas.map((a) => (
            <tr key={a.id} className={a.status === "good" ? "" : "warn"}>
              <td>{a.name}</td>
              <td>{Math.round(a.observed * 100)}%</td>
              <td>{a.errorPx == null ? "—" : `${a.errorPx.toFixed(1)} px`}</td>
              <td>{a.status === "good" ? "✓" : a.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const CameraReview = () => {
  const img = useAlign((s) => s.cameraImage);
  const pairs = useAlign((s) => s.pairs);
  const lines = useMemo(() => areasOnCamera().map((a) => ({ points: a.points, color: "#7fd4ff" })), [img, pairs]);
  if (!img) return null;
  return <ZoomImage url={img.url} size={img} label="Camera picture with the house areas" markers={pairs.map((p, i) => ({ n: i + 1, at: p.camera }))} lines={lines} onPick={() => {}} />;
};

const Review = () => {
  const s = useAlign();
  return (
    <div className="align-review">
      <div className="align-review-view">
        <CameraReview />
      </div>
      <div className="align-col">
        <Estimate />
        <div className="row gap wrap">
          <button className="ghost" onClick={() => useAlign.setState({ phase: "points" })}>
            Back to the points
          </button>
          <button className="primary" disabled={!!s.busy} onClick={() => run(Promise.resolve().then(applyAlignment))}>
            Apply to {s.projectorId ? "the projector" : ""}
          </button>
        </div>
        <p className="small muted">Applying keeps the alignment in use as a saved version: Ctrl+Z, or Restore previous, puts it back. The show's prepared frames are reused; nothing is rendered again.</p>
      </div>
    </div>
  );
};

const Applied = () => {
  const s = useAlign();
  const [outlines, setOutlines] = useState(false);
  return (
    <div className="align-review">
      <div className="align-review-view">
        <CameraReview />
      </div>
      <div className="align-col">
        <Estimate />
        <div className="row gap wrap">
          <button
            className={`ghost ${outlines ? "on" : ""}`}
            aria-pressed={outlines}
            onClick={() => {
              setOutlines(!outlines);
              run(projectOutlines(!outlines));
            }}
          >
            {outlines ? "Hide outlines on the house" : "Project the area outlines"}
          </button>
          <button className="ghost" disabled={!!s.busy || !s.phone?.connected} onClick={() => run(verify())}>
            Photograph the outlines
          </button>
          <button className="ghost" disabled={!!s.busy || !s.phone?.connected} onClick={() => run(checkAlignment())}>
            Check alignment
          </button>
          <button className="ghost" disabled={!!s.busy || !s.phone?.connected} onClick={() => run(realign())}>
            Realign
          </button>
          <button className="ghost" disabled={!!s.busy} onClick={() => run(Promise.resolve().then(restorePrevious))}>
            Restore previous
          </button>
          <button className="primary" onClick={() => (outlines ? run(projectOutlines(false).then(closeAlign)) : closeAlign())}>
            Done
          </button>
        </div>
        {s.busy && <p className="muted small">{s.busy}…</p>}
        {s.progress && <progress max={s.progress.total} value={s.progress.done} />}
        {s.check && <p className={s.check.verdict === "aligned" ? "ok-text small" : "warn small"}>{s.check.message}</p>}
        <p className="small muted">
          For a small correction, drag the numbered corner points in the Projector view; the measured fine correction stays on top. Check alignment and Realign need the phone where it was when the points were marked.
        </p>
      </div>
    </div>
  );
};

export type { ReferencePair };
