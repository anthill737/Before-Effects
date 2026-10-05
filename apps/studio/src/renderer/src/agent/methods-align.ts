/**
 * Agent methods for camera-assisted projector alignment: the same workflow as the "Auto-align with
 * phone" screen (studio/align/alignSession.ts), step by step.
 *
 *   Automatic: align.open → (phone scans the url) → align.phone.status until connected → align.checkView
 *   → align.auto (capture, match the house, solve, apply, check on the building and refine; runs in the
 *   background — poll align.status; align.cancel stops it).
 *   Step by step: align.start (capture) → align.match (or align.points.set by hand) → align.solve →
 *   align.apply → align.refine. Fixes: align.nudge (one area by projector pixels), align.areaPoint (one
 *   spot for an area that couldn't be matched). Later: align.check, align.realign, align.undo.
 */
import { calibrationMapping } from "@be/core";
import { z } from "zod";
import {
  addAreaPoint,
  alignSnapshot,
  applyAlignment,
  autoAlign,
  autoMatch,
  nudgeArea,
  phoneMoved,
  verifyAndRefine,
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
  summary: "Check: first whether the phone moved (verdict phone-moved: its matches are stale — realign), then capture the patterns and compare with the alignment in use: median/95% offset in projector pixels, per area, verdict aligned / moved.",
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
  summary: "Realign from scratch: capture, match the house again automatically (no stale points), solve, apply, check on the building and refine.",
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
    const v = activeVenue({ project: useStudio.getState().project! });
    const m = calibrationMapping(pr, v?.regions);
    if (!m) throw new AgentError("failed", "This projector's alignment points are degenerate.");
    return { mode: pr.calibration.mode, surfaces: pr.calibration.mesh?.surfaces ?? [], output: p.photo.map((q) => m.toOutput(q)) };
  },
});

method({
  name: "align.auto",
  summary:
    "The fully automatic run, in the background: capture the patterns, match the camera's view to the house photo, calculate, apply, then project the area outlines, measure them against the building's edges and refine (up to 3 rounds). Poll align.status (autoStep, match, estimate, verification). If matching isn't confident it stops at phase \"points\" for points by hand.",
  params: z.object({ brightness: z.number().int().min(40).max(255).optional() }),
  run: (p) => {
    needOpen();
    if (useAlign.getState().busy) throw new AgentError("busy", `Busy: ${useAlign.getState().busy}`);
    if (p.brightness) useAlign.setState({ level: p.brightness });
    void autoAlign().catch(() => {});
    return { started: true };
  },
});

method({
  name: "align.match",
  summary: "Match the camera's view (from the last capture) to the house photo automatically: confidence, feature matches, and per house area found / ambiguous (repeated windows) / weak / outside. Confident matches become the reference points.",
  params: z.object({}),
  long: true,
  run: () =>
    wrap(() => {
      needOpen();
      return autoMatch();
    }),
});

method({
  name: "align.refine",
  summary: "Project the area outlines, photograph them, measure each area against the building's edges (projector pixels; areas without visible edges are 'unverified') and correct areas that are off; repeats up to `rounds` times (1 = measure and correct once). Uses none of the fitted points.",
  params: z.object({ rounds: z.number().int().min(1).max(5).optional() }),
  long: true,
  run: (p) =>
    wrap(() => {
      needOpen();
      return verifyAndRefine(p.rounds ?? 3);
    }),
});

method({
  name: "align.nudge",
  summary: "Move one house area's projection by dx, dy projector pixels (only that area moves; repeated nudges of an area merge into one undo step).",
  params: z.object({ area: z.string().describe("house area id or name"), dx: z.number().min(-200).max(200), dy: z.number().min(-200).max(200) }),
  mutates: true,
  run: (p, ctx) => {
    needOpen();
    const v = activeVenue({ project: useStudio.getState().project! })!;
    const id = v.regions[p.area] ? p.area : Object.values(v.regions).find((r) => r.name.toLowerCase() === p.area.toLowerCase())?.id;
    if (!id) throw new AgentError("not_found", `No house area "${p.area}".`);
    ctx.edit(() => nudgeArea(id, p.dx, p.dy));
    return { moved: id };
  },
});

method({
  name: "align.areaPoint",
  summary: "Add one matching spot for a single house area (photo pixels ↔ camera pixels) — the fix for an area automatic matching couldn't place — and recalculate (then align.apply).",
  params: z.object({ area: z.string(), photo: vec, camera: vec }),
  long: true,
  run: (p) =>
    wrap(() => {
      needOpen();
      return addAreaPoint(p.area, p.photo, p.camera);
    }),
});

method({
  name: "align.phoneMoved",
  summary: "Whether the phone moved since the house was matched (a fresh picture compared with the matched one): still / moved / unknown, with the shift in camera pixels.",
  params: z.object({}),
  long: true,
  run: () =>
    wrap(() => {
      needOpen();
      return phoneMoved();
    }),
});
