/**
 * Several projectors on one building: editing them, and edge blending where their pictures overlap.
 *
 * Blending is worked out per point. Where a point of the content is lit by several projectors, each
 * contributes in proportion to how far that point lies inside its own frame (see edgeDistance,
 * shaped by the blend curve), so the weights always add up to 1 and the blend zone is exactly
 * the overlap, whatever its shape. Weights apply to linear light, before each projector's output
 * correction and display encoding, so the sum of the light stays even. The output warp shader
 * (engine OUTPUT_WARP) mirrors `blendWeight`.
 */
import { z } from "zod";
import { applyHomography, type Mat3, mat3Invert, solveHomography } from "./geometry.ts";
import type { Id, Projector, Vec2, Venue } from "./model.ts";
import { defineOp, OpError } from "./ops.ts";

export interface VenueBlend {
  /** Blend where projectors overlap (on by default once there are two). */
  readonly enabled: boolean;
  /** Shape of the cross-fade: 1 = straight, 2 = smooth S (default), 3 = softer still. */
  readonly curve: number;
}

export const DEFAULT_BLEND: VenueBlend = { enabled: true, curve: 2 };

/** At most this many projectors blend together (the shader's limit). */
export const MAX_BLENDED_PROJECTORS = 8;

export const venueBlend = (v: Pick<Venue, "projectorOrder"> & { readonly blend?: VenueBlend }): VenueBlend => v.blend ?? DEFAULT_BLEND;

/** Content px → projector output px, from the projector's alignment points; null if degenerate. */
export const contentToOutput = (p: Projector): Mat3 | null =>
  solveHomography(
    p.calibration.points.map((x) => x.content as Vec2),
    p.calibration.points.map((x) => x.output as Vec2),
  );

/**
 * How far inside its frame a projector output point is: the product of its distances to the
 * nearer side edge and the nearer top/bottom edge (each a fraction of that side), 0 at or beyond
 * the frame. The product keeps a side-by-side cross-fade straight however high up the point is.
 */
export const edgeDistance = (out: Vec2, size: { readonly width: number; readonly height: number }): number => {
  const [x, y] = out;
  if (!(x >= 0 && y >= 0 && x <= size.width && y <= size.height)) return 0;
  return (Math.min(x, size.width - x) / size.width) * (Math.min(y, size.height - y) / size.height);
};

/**
 * The share of the light at content point `c` that projector `self` gives (0..1), among `projectors`
 * (content→output homographies and output sizes). 1 where it's the only one lighting the point.
 */
export const blendWeight = (c: Vec2, self: number, projectors: ReadonlyArray<{ readonly h: Mat3; readonly size: { readonly width: number; readonly height: number } }>, curve: number): number => {
  const f = (e: number) => (e > 0 ? Math.pow(e, Math.max(0.25, curve)) : 0);
  const at = (i: number) => {
    const p = projectors[i]!;
    const w = p.h[2]! * c[0] + p.h[5]! * c[1] + p.h[8]!;
    return w > 0 ? f(edgeDistance(applyHomography(p.h, c), p.size)) : 0;
  };
  const mine = at(self);
  let total = mine;
  for (let i = 0; i < projectors.length; i++) if (i !== self) total += at(i);
  return total > 1e-12 ? mine / total : mine > 0 ? 1 : 0;
};

/** The blend inputs for a venue's projectors (in order), skipping ones with degenerate alignment. */
export const blendSetup = (venue: Venue): Array<{ id: Id; h: Mat3; hinv: Mat3; size: { width: number; height: number } }> =>
  venue.projectorOrder
    .map((id) => venue.projectors[id])
    .filter((p): p is Projector => !!p)
    .slice(0, MAX_BLENDED_PROJECTORS)
    .flatMap((p) => {
      const h = contentToOutput(p);
      const hinv = h ? mat3Invert(h) : null;
      return h && hinv ? [{ id: p.id, h, hinv, size: { width: p.output.width, height: p.output.height } }] : [];
    });

/**
 * A starting alignment for several projectors sharing the picture: side by side (or stacked), each
 * covering an equal slice with `overlap` (fraction of a slice) shared with its neighbour, the slice
 * fitted inside that projector's frame. Fine-tune each afterwards by dragging its points.
 */
export const arrangeProjectors = (
  canvas: { readonly width: number; readonly height: number },
  outputs: ReadonlyArray<{ readonly width: number; readonly height: number }>,
  layout: "side-by-side" | "stacked",
  overlap: number,
): Array<Array<{ id: string; label: string; content: Vec2; output: Vec2 }>> => {
  const n = Math.max(1, outputs.length);
  const o = Math.min(0.9, Math.max(0, overlap));
  const along = layout === "side-by-side" ? canvas.width : canvas.height;
  const slice = along / (n - (n - 1) * o);
  return outputs.map((out, i) => {
    const a0 = i * slice * (1 - o);
    const [x0, y0, w, h] = layout === "side-by-side" ? [a0, 0, slice, canvas.height] : [0, a0, canvas.width, slice];
    const k = Math.min(out.width / w, out.height / h);
    const ox = (out.width - w * k) / 2, oy = (out.height - h * k) / 2;
    const pt = (id: string, cx: number, cy: number) => ({ id, label: id.slice(1), content: [cx, cy] as Vec2, output: [ox + (cx - x0) * k, oy + (cy - y0) * k] as Vec2 });
    return [pt("c1", x0, y0), pt("c2", x0 + w, y0), pt("c3", x0 + w, y0 + h), pt("c4", x0, y0 + h)];
  });
};

// ---- operations ---------------------------------------------------------------------------------

type Draft<T> = { -readonly [K in keyof T]: Draft<T[K]> };
const venueOf = (d: { venues: Record<Id, Venue> }, id: Id): Draft<Venue> => {
  const v = d.venues[id];
  if (!v) throw new OpError("That space no longer exists.");
  return v as Draft<Venue>;
};

export const projectorUpdate = defineOp({
  type: "projector.update",
  title: "Change projector",
  description: "Rename a projector, change its output size (pixels), the display it's connected to, or its output correction (gamma, gain, black level).",
  args: z.object({
    venueId: z.string(),
    projectorId: z.string(),
    changes: z
      .object({
        name: z.string().min(1),
        output: z.object({ width: z.number().int().min(16).max(16384), height: z.number().int().min(16).max(16384), displayId: z.string().optional() }),
        outputColor: z.object({ gamma: z.number().min(0.2).max(5), gain: z.tuple([z.number(), z.number(), z.number(), z.number()]), blackLevel: z.number().min(0).max(0.5) }),
      })
      .partial(),
  }),
  apply: (d, a) => {
    const v = venueOf(d as never, a.venueId);
    const p = v.projectors[a.projectorId];
    if (!p) throw new OpError("That projector no longer exists.");
    if (a.changes.name) p.name = a.changes.name;
    if (a.changes.output) {
      // Keep the alignment points where they were relative to the frame.
      const sx = a.changes.output.width / p.output.width, sy = a.changes.output.height / p.output.height;
      if (sx !== 1 || sy !== 1) for (const pt of p.calibration.points) pt.output = [pt.output[0] * sx, pt.output[1] * sy];
      p.output = { ...a.changes.output } as never;
    }
    if (a.changes.outputColor) p.outputColor = a.changes.outputColor as never;
  },
  summarize: (a) => `Changed projector ${a.changes.name ? `"${a.changes.name}"` : ""}`.trim(),
});

export const projectorRemove = defineOp({
  type: "projector.remove",
  title: "Remove projector",
  description: "Remove a projector (and its alignment) from a space.",
  args: z.object({ venueId: z.string(), projectorId: z.string() }),
  apply: (d, a) => {
    const v = venueOf(d as never, a.venueId);
    if (!v.projectors[a.projectorId]) throw new OpError("That projector no longer exists.");
    delete v.projectors[a.projectorId];
    v.projectorOrder = v.projectorOrder.filter((x) => x !== a.projectorId);
  },
});

export const venueSetBlend = defineOp({
  type: "venue.setBlend",
  title: "Edge blending",
  description: "Turn edge blending between overlapping projectors on or off, and shape its cross-fade (curve 1 = straight … 3 = softest).",
  args: z.object({ venueId: z.string(), enabled: z.boolean().optional(), curve: z.number().min(0.5).max(4).optional() }),
  apply: (d, a) => {
    const v = venueOf(d as never, a.venueId) as Draft<Venue> & { blend?: VenueBlend };
    const cur = v.blend ?? DEFAULT_BLEND;
    v.blend = { enabled: a.enabled ?? cur.enabled, curve: a.curve ?? cur.curve };
  },
});

export const projectionOps = [projectorUpdate, projectorRemove, venueSetBlend];
