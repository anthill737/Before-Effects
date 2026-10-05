/**
 * Agent methods for camera-assisted projector alignment: the same workflow as the "Auto-align with
 * phone" screen (studio/align/alignSession.ts), step by step.
 *
 *   align.open → (phone scans align.open's url) → align.phone.status until connected → align.checkView
 *   → align.start (capture runs in the background; align.status shows progress; align.cancel stops it)
 *   → align.points.set (≥ 4 camera↔photo pairs) → align.solve → align.apply → align.outlines / align.verify
 *   → later: align.check, align.realign, align.undo.
 */
import { mapContentToOutput, solveHomography } from "@be/core";
import { z } from "zod";
import {
  alignSnapshot,
  applyAlignment,
  areasOnCamera,
  cancelAlign,
  capturePatterns,
  checkAlignment,
  checkView,
  closeAlign,
  openAlign,
  pointProblems,
  projectOutlines,
  realign,
  restorePrevious,
  setPairs,
  solve,
  useAlign,
  verify,
} from "../studio/align/alignSession.ts";
import { activeVenue, useStudio } from "../studio/store.ts";
import { AgentError, method } from "./core.ts";
import { projectorRef } from "./methods-projectors.ts";

const vec = z.tuple([z.number(), z.number()]);
const wrap = async <T>(fn: () => Promise<T> | T): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    throw new AgentError("failed", e instanceof Error ? e.message : String(e));
  }
};
const needOpen = () => {
  if (!useAlign.getState().projectorId) throw new AgentError("not_ready", "Call align.open first.");
};

method({
  name: "align.open",
  summary:
    "Start camera-assisted alignment for a projector: serves the phone camera page and returns its address (open it on a phone on the same Wi-Fi; it warns once about the self-made certificate), a QR code (SVG) and the phone's status. Also opens the Auto-align screen.",
  params: z.object({ projector: z.string().describe("projector id or name"), showScreen: z.boolean().optional().describe("open the Auto-align screen in the app (default true)") }),
  run: (p) =>
    wrap(async () => {
      const v = activeVenue({ project: useStudio.getState().project! });
      if (!v) throw new AgentError("not_found", "There's no building (venue) yet.");
      const pr = projectorRef(p.projector);
      await openAlign(v.id, pr.id);
      if (p.showScreen === false) useAlign.setState({ open: false });
      const s = useAlign.getState();
      return { url: s.phone?.url ?? null, qrSvg: s.qrSvg, phone: s.phone, savedReferencePoints: s.pairs.length };
    }),
});

method({
  name: "align.close",
  summary: "Close the Auto-align screen (the phone stays connected; align.phone.stop disconnects it).",
  params: z.object({}),
  run: () => {
    closeAlign();
    return { ok: true };
  },
});

method({
  name: "align.phone.status",
  summary: "The phone camera connection: running, connected, device, camera size, orientation, exposure/focus lock support, last frame.",
  params: z.object({}),
  run: () => window.be.phone.status(),
});

method({
  name: "align.phone.stop",
  summary: "Stop serving the phone page and disconnect the phone.",
  params: z.object({}),
  run: async () => {
    await window.be.phone.stop();
    return { ok: true };
  },
});

method({
  name: "align.phone.capture",
  summary: "Take a full-size picture with the phone camera now. Returns the saved JPEG's path and size (read the file to look at it).",
  params: z.object({ settleMs: z.number().int().min(0).max(5000).optional() }),
  long: true,
  run: (p) =>
    wrap(async () => {
      const c = await window.be.phone.capture({ settleMs: p.settleMs ?? 100 });
      return { path: c.path, width: c.width, height: c.height, at: c.at };
    }),
});

method({
  name: "align.checkView",
  summary: "Project white then black and report whether the camera sees the whole lit area (litShare, sides cut off, a plain message).",
  params: z.object({}),
  long: true,
  run: () =>
    wrap(() => {
      needOpen();
      return checkView();
    }),
});

method({
  name: "align.start",
  summary:
    "Start capturing the alignment patterns in the background (about half a minute; the projector shows slow black/white stripes). Poll align.status for progress; align.cancel stops. When done, the decode summary is in align.status and the camera picture (house lit white) is at cameraImage.path.",
  params: z.object({ brightness: z.number().int().min(40).max(255).optional().describe("pattern brightness 0–255 (default 200)") }),
  run: (p) => {
    needOpen();
    if (useAlign.getState().busy) throw new AgentError("busy", `Busy: ${useAlign.getState().busy}`);
    if (p.brightness) useAlign.setState({ level: p.brightness });
    void capturePatterns().catch(() => {});
    return { started: true };
  },
});

method({
  name: "align.cancel",
  summary: "Stop the capture in progress (the projector goes back to the show).",
  params: z.object({}),
  run: () => {
    cancelAlign();
    return { ok: true };
  },
});

method({
  name: "align.status",
  summary: "Where the alignment is: phase, what it's doing and progress, phone, view check, decode summary, reference points, estimate (confidence, errors per area), last check, errors.",
  params: z.object({}),
  run: () => alignSnapshot(),
});

method({
  name: "align.points.set",
  summary:
    "Set the reference points: each pairs a spot in the camera picture (pixels of align.status cameraImage) with the same spot in the house photo (venue canvas pixels, as house areas use). At least 4, spread over the house; add points on parts that stand out or sit back (columns, recessed doors, gables) to correct those.",
  params: z.object({ points: z.array(z.object({ camera: vec, photo: vec })) }),
  run: (p) => {
    needOpen();
    setPairs(p.points);
    return { count: p.points.length, problems: pointProblems() };
  },
});

method({
  name: "align.solve",
  summary: "Calculate the alignment from the capture and the reference points (nothing is applied). Returns confidence, reference-point error and fit in projector pixels, measured share, and per-area status.",
  params: z.object({}),
  long: true,
  run: () =>
    wrap(() => {
      needOpen();
      return solve();
    }),
});

method({
  name: "align.areasOnCamera",
  summary: "The house areas drawn in camera-picture pixels as the solved alignment sees them (to compare with the real building in the camera picture).",
  params: z.object({}),
  run: () => areasOnCamera(),
});

method({
  name: "align.apply",
  summary: "Apply the solved alignment to the projector (one undoable step; the previous alignment is saved as a version). Prepared show frames are reused — alignment is applied when the output is shown.",
  params: z.object({}),
  mutates: true,
  run: (_p, ctx) => {
    needOpen();
    const previousVersion = ctx.edit(() => applyAlignment());
    return { applied: true, previousVersion };
  },
});

method({
  name: "align.undo",
  summary: "Restore the projector's alignment from before the last align.apply.",
  params: z.object({}),
  mutates: true,
  run: (_p, ctx) => {
    needOpen();
    ctx.edit(() => restorePrevious());
    return { restored: true };
  },
});

method({
  name: "align.outlines",
  summary: "Project the house-area outlines through the projector's current alignment (on: true), or go back to the show (on: false).",
  params: z.object({ on: z.boolean() }),
  run: (p) =>
    wrap(async () => {
      needOpen();
      await projectOutlines(p.on);
      return { on: p.on };
    }),
});

method({
  name: "align.verify",
  summary: "Project the area outlines and photograph them with the phone: returns the picture's path and where the areas should appear in it (camera pixels), to compare.",
  params: z.object({}),
  long: true,
  run: () =>
    wrap(() => {
      needOpen();
      return verify();
    }),
});

method({
  name: "align.check",
  summary: "Capture the patterns again and compare with the alignment in use: median/95% offset in projector pixels, per area, and a verdict (aligned / moved). Needs the phone where it was when the points were marked.",
  params: z.object({}),
  long: true,
  run: () =>
    wrap(() => {
      needOpen();
      return checkAlignment();
    }),
});

method({
  name: "align.realign",
  summary: "Capture again and solve with the reference points already marked (after the projector moved; the phone must not have). Then align.apply.",
  params: z.object({}),
  long: true,
  run: () =>
    wrap(() => {
      needOpen();
      return realign();
    }),
});

method({
  name: "align.where",
  summary: "Where house-photo points (venue canvas pixels) land in a projector's output pixels through its current alignment (homography and measured correction grid).",
  params: z.object({ projector: z.string(), photo: z.array(vec).max(10000) }),
  run: (p) => {
    const pr = projectorRef(p.projector);
    const cal = pr.calibration;
    const H = solveHomography(
      cal.points.map((x) => x.content),
      cal.points.map((x) => x.output),
    );
    if (!H) throw new AgentError("failed", "This projector's alignment points are degenerate.");
    const mesh = cal.mode === "mesh" ? cal.mesh : undefined;
    return { mode: cal.mode, output: p.photo.map((q) => mapContentToOutput(H, mesh, pr.output.width, pr.output.height, q)) };
  },
});
