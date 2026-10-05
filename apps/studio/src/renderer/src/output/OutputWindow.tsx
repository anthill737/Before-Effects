/**
 * Full-screen projector output. Shows only the projector image: no editor UI. The mouse shows while
 * it moves (to point at things on the house while editing) and hides after a few seconds still.
 *
 * It renders at the projector's configured output size, independent of the editor's preview size.
 * Test patterns help identify the right display and check alignment. Press Esc to close it.
 */
import { useEffect, useRef, useState } from "react";
import "../studio/styles.css";
import { calibrationMapping, flattenPath, stripeLit, type Projector, type Vec2, type Venue } from "@be/core";
import type { OutputConfig, TestPattern } from "../../../shared/api.ts";
import { PreviewLoop, usePreviewStats } from "../preview/loop.ts";
import { usePreview } from "../preview/settings.ts";
import { editorSource } from "../preview/PreviewPanel.tsx";
import { followerClockError, startFollowerSync } from "../preview/sync.ts";
import { getMediaHost, getRenderer } from "../studio/engineHost.ts";
import { venuePhoto } from "../space/actions.ts";
import { useStudio } from "../studio/store.ts";
import { onSimFrame } from "../studio/simHost.ts";

/** Graphics memory for an output's frames (MB): the few seconds read ahead from disk, with room to spare. */
const OUTPUT_CACHE_MB = 2048;
let reportTimer = 0;

/** Camera-alignment patterns: flat black / grey, or Gray-code stripes (see core autoAlign.ts). */
const drawAlign = (g: CanvasRenderingContext2D, pattern: string, w: number, h: number) => {
  const parts = pattern.split(":");
  g.fillStyle = "#000";
  g.fillRect(0, 0, w, h);
  if (parts[1] === "black") return;
  const level = Math.max(0, Math.min(255, Number(parts.at(-1)) || 200));
  g.fillStyle = `rgb(${level},${level},${level})`;
  if (parts[1] === "white") {
    g.fillRect(0, 0, w, h);
    return;
  }
  const axis = parts[1] === "y" ? "y" : "x";
  const p = { axis, bit: Number(parts[2]), inverse: parts[3] === "1" } as const;
  const block = Number(parts[4]) || 4;
  const n = axis === "x" ? w : h;
  // Runs of lit columns (or rows), drawn as rectangles.
  let start = -1;
  for (let i = 0; i <= n; i++) {
    const lit = i < n && stripeLit(p, axis === "x" ? i : 0, axis === "y" ? i : 0, block);
    if (lit && start < 0) start = i;
    else if (!lit && start >= 0) {
      if (axis === "x") g.fillRect(start, 0, i - start, h);
      else g.fillRect(0, start, w, i - start);
      start = -1;
    }
  }
};

/** The house areas drawn through the projector's current alignment, to check it on the building. */
const drawOutlines = (g: CanvasRenderingContext2D, venue: Venue, projector: Projector, w: number, h: number, names = true) => {
  g.fillStyle = "#000";
  g.fillRect(0, 0, w, h);
  const m = calibrationMapping(projector, venue.regions);
  if (!m) return;
  const sx = w / projector.output.width;
  const sy = h / projector.output.height;
  const toOut = (q: Vec2): Vec2 => {
    const p = m.toOutput(q);
    return [p[0] * sx, p[1] * sy];
  };
  g.lineWidth = Math.max(2, Math.round(w / 640));
  g.lineJoin = "round";
  g.font = `600 ${Math.round(h * 0.022)}px Segoe UI, sans-serif`;
  g.textAlign = "center";
  for (const r of Object.values(venue.regions)) {
    const pts = flattenPath(r.path, 8);
    if (pts.length < 2) continue;
    // Densify, so the curve follows the alignment grid between the outline's corners.
    const dense: Vec2[] = [];
    const ring = r.path.closed ? [...pts, pts[0]!] : pts;
    for (let i = 0; i + 1 < ring.length; i++) {
      const a = ring[i]!, b = ring[i + 1]!;
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 6));
      for (let k = 0; k < steps; k++) dense.push([a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps]);
    }
    dense.push(ring.at(-1)!);
    g.strokeStyle = "#7fd4ff";
    g.beginPath();
    dense.map(toOut).forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
    g.stroke();
    const cx = pts.reduce((t, p) => t + p[0], 0) / pts.length;
    const cy = pts.reduce((t, p) => t + p[1], 0) / pts.length;
    const c = toOut([cx, cy]);
    g.fillStyle = "#ffffff";
    if (names) g.fillText(r.name, c[0], c[1]);
  }
};

/**
 * The house photo projected through the alignment (to check it with the camera: projected texture vs
 * the building's own). Mapped per 4-pixel block and interpolated inside — plenty for measuring.
 */
const drawPhoto = (g: CanvasRenderingContext2D, photo: ImageData, venue: Venue, projector: Projector, w: number, h: number) => {
  const m = calibrationMapping(projector, venue.regions);
  const out = g.createImageData(w, h);
  if (!m) return g.putImageData(out, 0, 0);
  const sx = projector.output.width / w, sy = projector.output.height / h;
  const kx = photo.width / venue.canvas.width, ky = photo.height / venue.canvas.height;
  const B = 4;
  const gw = Math.ceil(w / B) + 1, gh = Math.ceil(h / B) + 1;
  const grid = new Float32Array(gw * gh * 2);
  for (let j = 0; j < gh; j++)
    for (let i = 0; i < gw; i++) {
      const q = m.toContent([i * B * sx, j * B * sy]);
      grid[(j * gw + i) * 2] = q[0] * kx;
      grid[(j * gw + i) * 2 + 1] = q[1] * ky;
    }
  const src = photo.data, dst = out.data;
  for (let y = 0; y < h; y++) {
    const j = Math.floor(y / B), ty = (y - j * B) / B;
    for (let x = 0; x < w; x++) {
      const i = Math.floor(x / B), tx = (x - i * B) / B;
      const a = (j * gw + i) * 2, b = a + 2, c = a + gw * 2, d = c + 2;
      const u = (grid[a]! * (1 - tx) + grid[b]! * tx) * (1 - ty) + (grid[c]! * (1 - tx) + grid[d]! * tx) * ty;
      const v = (grid[a + 1]! * (1 - tx) + grid[b + 1]! * tx) * (1 - ty) + (grid[c + 1]! * (1 - tx) + grid[d + 1]! * tx) * ty;
      const xi = Math.round(u), yi = Math.round(v);
      const o = (y * w + x) * 4;
      dst[o + 3] = 255;
      if (xi < 0 || yi < 0 || xi >= photo.width || yi >= photo.height) continue;
      const p = (yi * photo.width + xi) * 4;
      dst[o] = src[p]!;
      dst[o + 1] = src[p + 1]!;
      dst[o + 2] = src[p + 2]!;
    }
  }
  g.putImageData(out, 0, 0);
};

const photoCache = new Map<string, ImageData>();
/** The house photo's pixels (loaded once). */
const housePhoto = async (venue: Venue): Promise<ImageData | null> => {
  const key = `${venue.id}:${venue.referenceAssetId ?? ""}`;
  const hit = photoCache.get(key);
  if (hit) return hit;
  const project = useStudio.getState().project;
  if (!project) return null;
  const blob = await venuePhoto(project);
  if (!blob) return null;
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext("2d")!;
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const d = g.getImageData(0, 0, c.width, c.height);
  photoCache.set(key, d);
  return d;
};

const drawPattern = (c: HTMLCanvasElement, pattern: TestPattern, label: string, w: number, h: number, place?: { venue: Venue; projector: Projector }, photo?: ImageData | null) => {
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, w, h);
  if (pattern === "none") return;
  if (pattern.startsWith("align:")) return drawAlign(g, pattern, w, h);
  if (pattern === "photo") {
    g.fillStyle = "#000";
    g.fillRect(0, 0, w, h);
    if (place && photo) drawPhoto(g, photo, place.venue, place.projector, w, h);
    return;
  }
  if (pattern === "outlines" || pattern === "outlines:plain") {
    // "plain": without the areas' names (for measuring them with the camera).
    if (place) drawOutlines(g, place.venue, place.projector, w, h, pattern === "outlines");
    return;
  }
  if (pattern === "black") {
    g.fillStyle = "#000";
    g.fillRect(0, 0, w, h);
    return;
  }
  if (pattern === "white") {
    g.fillStyle = "#fff";
    g.fillRect(0, 0, w, h);
    return;
  }
  if (pattern === "checker") {
    const n = 16;
    const cw = w / n;
    const rows = Math.ceil(h / cw);
    for (let y = 0; y < rows; y++) for (let x = 0; x < n; x++) {
      g.fillStyle = (x + y) % 2 ? "#fff" : "#000";
      g.fillRect(x * cw, y * cw, cw + 1, cw + 1);
    }
    return;
  }
  if (pattern === "colors") {
    const bars = ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"];
    bars.forEach((col, i) => {
      g.fillStyle = col;
      g.fillRect((i * w) / bars.length, 0, w / bars.length + 1, h);
    });
    return;
  }
  // grid / identify: black, fine grid, centre cross, corner markers, size info
  g.fillStyle = "#000";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = pattern === "grid" ? "#ffffff" : "#3b82f6";
  g.lineWidth = Math.max(1, Math.round(w / 1920));
  for (let i = 0; i <= 16; i++) {
    const x = Math.round((i * (w - 1)) / 16) + 0.5;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
  }
  for (let i = 0; i <= 9; i++) {
    const y = Math.round((i * (h - 1)) / 9) + 0.5;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
  }
  g.strokeStyle = "#ffc56b";
  g.lineWidth *= 3;
  g.strokeRect(2, 2, w - 4, h - 4);
  g.beginPath();
  g.moveTo(w / 2 - h / 10, h / 2);
  g.lineTo(w / 2 + h / 10, h / 2);
  g.moveTo(w / 2, h / 2 - h / 10);
  g.lineTo(w / 2, h / 2 + h / 10);
  g.stroke();
  if (pattern === "identify") {
    g.fillStyle = "#ffc56b";
    g.font = `700 ${Math.round(h * 0.35)}px Segoe UI, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(label.split(" ")[0] ?? "", w / 2, h * 0.42);
    g.font = `600 ${Math.round(h * 0.05)}px Segoe UI, sans-serif`;
    g.fillStyle = "#fff";
    g.fillText(label, w / 2, h * 0.72);
    g.font = `400 ${Math.round(h * 0.032)}px Segoe UI, sans-serif`;
    g.fillText(`${w} × ${h} output pixels`, w / 2, h * 0.8);
  }
};

export const OutputWindow = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const patternRef = useRef<HTMLCanvasElement>(null);
  const [config, setConfig] = useState<OutputConfig | null>(null);
  const [status, setStatus] = useState("Connecting to the editor…");
  const project = useStudio((s) => s.project);
  const loopRef = useRef<PreviewLoop | null>(null);
  const [cursorShown, setCursorShown] = useState(false);
  useEffect(() => {
    let t = 0;
    const moved = () => {
      setCursorShown(true);
      clearTimeout(t);
      t = window.setTimeout(() => setCursorShown(false), 3000);
    };
    window.addEventListener("mousemove", moved);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousemove", moved);
    };
  }, []);

  useEffect(() => {
    let off: (() => void) | null = null;
    let offCfg: (() => void) | null = null;
    void (async () => {
      const hello = await window.be.sync.hello();
      if (hello.output) setConfig(hello.output);
      offCfg = window.be.sync.onOutputConfig(setConfig);
      // Edits in the editor: frames this output holds that they change are drawn again.
      off = await startFollowerSync((m) => m.compId && loopRef.current?.invalidate(m.compId, m.affected, m.others));
      setStatus("");
    })();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") window.close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      off?.();
      offCfg?.();
      window.removeEventListener("keydown", onKey);
      clearInterval(reportTimer);
      loopRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    if (!config || !canvasRef.current || loopRef.current) return;
    void getRenderer().then((r) => {
      if (!canvasRef.current) return;
      const loop = new PreviewLoop(r, canvasRef.current, editorSource, () => ({ width: window.innerWidth, height: window.innerHeight }));
      loop.fixed = { view: "projector", projectorId: config.projectorId, fraction: 1 };
      // Prepared frames come from disk a few seconds ahead: graphics memory for that, not the
      // editor's whole frame cache (each output is a window of its own).
      loop.cache.setBudget(Math.min(usePreview.getState().cacheBudgetMB, OUTPUT_CACHE_MB) * 1024 * 1024);
      // Tell the editor what this output shows, four times a second: the frame, different frames
      // shown and frames passed over, how far its picture is from the editor's clock (the sound),
      // and draws (redraws included), for checking outputs keep up and stay in step.
      const drawn: number[] = [];
      let frameNow = 0;
      loop.onFrame = (frame) => {
        const now = performance.now();
        frameNow = frame;
        drawn.push(now);
      };
      reportTimer = window.setInterval(() => {
        const now = performance.now();
        while (drawn.length && now - drawn[0]! > 1000) drawn.shift();
        const st = usePreviewStats.getState();
        const s = useStudio.getState();
        const onDisk = s.project && s.compId ? loop.disk.framesOnDisk(s.project, s.compId, 1, "full").size : 0;
        const MB = (n: number) => Math.round(n / 1048576);
        const pool = r.gpu.poolReport();
        const memoryMB = { frameCache: MB(loop.cache.stats().bytes), media: MB(getMediaHost()?.memoryReport().bytes ?? 0), poolInUse: MB(pool.inUseBytes), poolFree: MB(pool.freeBytes), scene3d: MB(r.scenes.memoryReport().targetBytes + r.scenes.memoryReport().sceneBytes) };
        const ahead = s.compId ? loop.readyAhead(s.compId, frameNow, 1, "full", 90) : 0;
        const clock = followerClockError();
        window.be.windows.reportOutputFrame({ frame: frameNow, fps: drawn.length, unique: st.achievedFps, skipped: st.dropped, stepsBack: st.stepsBack, causes: { ...loop.causes }, clockErrMs: clock.recentMs, clockErrMaxMs: clock.maxMs, syncMs: st.avSyncMs, syncMaxMs: st.avSyncMaxMs, diskReadMs: st.diskReadMs, framesOnDisk: onDisk, ahead, playing: s.playing, memoryMB });
      }, 250);
      loopRef.current = loop;
      getMediaHost()?.onLoaded(() => loop.invalidateView());
      onSimFrame(() => loop.invalidateView());
      loop.start();
    });
  }, [config]);

  useEffect(() => {
    if (loopRef.current && config) loopRef.current.fixed = { view: "projector", projectorId: config.projectorId, fraction: 1 };
  }, [config]);

  const venue = project && config ? project.venues[config.venueId] : undefined;
  const projector = venue && config ? venue.projectors[config.projectorId] : undefined;

  useEffect(() => {
    if (!patternRef.current || !projector || !config) return;
    const canvas = patternRef.current;
    const pattern = config.pattern;
    let r1 = 0, r2 = 0, gone = false;
    const draw = (photo?: ImageData | null) => {
      if (gone) return;
      drawPattern(canvas, pattern, `${projector.name.replace(/^Projector\s*/i, "") || "1"} ${projector.name}`, projector.output.width, projector.output.height, venue ? { venue, projector } : undefined, photo);
      // Reported once it's on screen (two frames later), so alignment capture knows the projector shows it.
      r1 = requestAnimationFrame(() => {
        r2 = requestAnimationFrame(() => window.be.windows.reportOutputPattern(pattern));
      });
    };
    if (pattern === "photo" && venue) void housePhoto(venue).then(draw, () => draw(null));
    else draw();
    return () => {
      gone = true;
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
  }, [config, projector?.output.width, projector?.output.height, projector?.name, config?.pattern?.startsWith("outlines") || config?.pattern === "photo" ? projector?.calibration : null, config?.pattern?.startsWith("outlines") || config?.pattern === "photo" ? venue?.regions : null]);

  return (
    <div className={`output-window ${cursorShown ? "" : "cursor-hidden"}`}>
      <canvas ref={canvasRef} className="output-canvas" />
      <canvas ref={patternRef} className="output-canvas pattern" style={{ display: config?.pattern && config.pattern !== "none" ? "block" : "none" }} />
      {status && <div className="output-status">{status}</div>}
    </div>
  );
};

/** Big display number shown on every screen while identifying displays. */
export const IdentifyOverlay = () => {
  const n = (window as unknown as { beDisplayNumber?: number }).beDisplayNumber ?? 0;
  return (
    <div className="identify">
      <div className="identify-num">{n}</div>
      <div className="identify-label">Display {n}</div>
    </div>
  );
};
