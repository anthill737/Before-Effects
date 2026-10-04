/**
 * Measuring a 3D model (glTF / GLB) when it's imported: its extent and a convex hull of its shape
 * (its collider when it's given physics), in metres in the model's own frame, plus what's in the
 * file. The hull is cut down to at most MAX_HULL points, picked farthest-first from the hull's own
 * corners, so the physics description stays small and the same file always gives the same hull.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ConvexHull } from "three/examples/jsm/math/ConvexHull.js";
import type { ModelInfo } from "@be/core";

const MAX_HULL = 64;
/** Vertices read per model at most (a dense scan adds nothing to a hull). */
const MAX_POINTS = 60_000;

const round = (v: number) => Math.round(v * 1e4) / 1e4;

/** Farthest-point selection: a few points that keep the shape's extremes, always the same for the same input. */
const spread = (pts: THREE.Vector3[], n: number): THREE.Vector3[] => {
  if (pts.length <= n) return pts;
  const centre = pts.reduce((c, p) => c.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
  let first = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i]!.distanceToSquared(centre) > pts[first]!.distanceToSquared(centre)) first = i;
  const picked = [pts[first]!];
  const dist = pts.map((p) => p.distanceToSquared(pts[first]!));
  while (picked.length < n) {
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (dist[i]! > dist[best]!) best = i;
    const p = pts[best]!;
    picked.push(p);
    for (let i = 0; i < pts.length; i++) dist[i] = Math.min(dist[i]!, pts[i]!.distanceToSquared(p));
  }
  return picked;
};

export const analyzeModel = async (bytes: Uint8Array): Promise<ModelInfo> => {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const gltf = await new GLTFLoader().parseAsync(buf, "");
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  let meshes = 0;
  let triangles = 0;
  let lights = 0;
  let total = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry?.attributes.position) total += m.geometry.attributes.position.count;
    if ((o as THREE.Light).isLight) lights++;
  });
  const stride = Math.max(1, Math.ceil(total / MAX_POINTS));
  const points: THREE.Vector3[] = [];
  const box = new THREE.Box3();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry?.attributes.position) return;
    meshes++;
    const pos = m.geometry.attributes.position;
    triangles += m.geometry.index ? m.geometry.index.count / 3 : pos.count / 3;
    for (let i = 0; i < pos.count; i += stride) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      points.push(v);
      box.expandByPoint(v);
    }
  });
  let hull: number[] = [];
  if (points.length >= 4) {
    try {
      const h = new ConvexHull().setFromPoints(points);
      const corners: THREE.Vector3[] = [];
      const seen = new Set<string>();
      for (const v of h.vertices) {
        const p = v.point;
        const k = `${round(p.x)},${round(p.y)},${round(p.z)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        corners.push(p.clone());
      }
      hull = spread(corners, MAX_HULL).flatMap((p) => [round(p.x), round(p.y), round(p.z)]);
    } catch {
      hull = [];
    }
  }
  // A flat or degenerate model: its bounding box instead.
  if (hull.length < 12 && !box.isEmpty()) {
    const { min, max } = box;
    const t = Math.max(0.005, (max.y - min.y) * 0.01);
    for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z - t, max.z + t]) hull.push(round(x), round(y), round(z));
  }
  return {
    bounds: box.isEmpty() ? [0, 0, 0, 0, 0, 0] : [round(box.min.x), round(box.min.y), round(box.min.z), round(box.max.x), round(box.max.y), round(box.max.z)],
    hull,
    meshes,
    triangles: Math.round(triangles),
    animations: gltf.animations.length,
    lights,
  };
};
