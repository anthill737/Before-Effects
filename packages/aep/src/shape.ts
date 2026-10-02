/**
 * Bezier paths (mask paths and shape-layer paths) stored as `LIST:shap`.
 *
 * File-format knowledge from py_aep (MIT, © 2023 Fortiche production, https://github.com/forticheprod/py-aep)
 * and aftereffects-aep-parser (MIT, © 2020 Boltframe).
 *
 * `shph` holds a closed/open flag and a bounding box; the `list` holds float32 (x, y) points
 * normalised to that box, three per vertex: vertex, its out-handle, and the in-handle of the
 * following vertex. Mask paths are additionally normalised to the layer's size.
 */

import type { AeJsonShape } from "@be/core";
import { Bin } from "./bin.ts";
import { type Chunk, find, findList } from "./riff.ts";

export function readShap(bin: Bin, shap: Chunk, scale: readonly [number, number] | null): AeJsonShape {
  const shph = find(shap.children, "shph");
  const list = findList(shap.children, "list");
  const ldat = list ? find(list.children, "ldat") : undefined;
  const lhd3 = list ? find(list.children, "lhd3") : undefined;
  const flags = shph ? bin.cu8(shph, 3) : 1;
  const closed = (flags & 0x08) === 0;
  const x0 = shph ? bin.cf32(shph, 4) : 0;
  const y0 = shph ? bin.cf32(shph, 8) : 0;
  const x1 = shph ? bin.cf32(shph, 12) : 1;
  const y1 = shph ? bin.cf32(shph, 16) : 1;
  const sx = scale ? scale[0] : 1;
  const sy = scale ? scale[1] : 1;

  const pts: [number, number][] = [];
  if (ldat) {
    const itemSize = lhd3 ? bin.cu16(lhd3, 18, 8) || 8 : 8;
    const count = lhd3 ? bin.cu16(lhd3, 10) : Math.floor((ldat.end - ldat.start) / itemSize);
    for (let i = 0; i < count; i++) {
      const o = ldat.start + i * itemSize;
      if (o + 8 > ldat.end) break;
      const nx = bin.f32(o);
      const ny = bin.f32(o + 4);
      pts.push([(x0 * (1 - nx) + x1 * nx) * sx, (y0 * (1 - ny) + y1 * ny) * sy]);
    }
  }
  const vertices: number[][] = [];
  const inTangents: number[][] = [];
  const outTangents: number[][] = [];
  const n = pts.length;
  for (let i = 0; i + 1 < n; i += 3) {
    const v = pts[i]!;
    const o = pts[i + 1]!;
    const inn = pts[(i - 1 + n) % n]!;
    vertices.push([v[0], v[1]]);
    outTangents.push([o[0] - v[0], o[1] - v[1]]);
    inTangents.push([inn[0] - v[0], inn[1] - v[1]]);
  }
  return { closed, vertices, inTangents, outTangents };
}
