/**
 * 3D scenes via three.js (WebGPU renderer) on the compositor's own GPUDevice, so a 3D render is a
 * texture the compositor samples directly.
 *
 * Scenes are built from the project's own 3D data (see @be/core world3d): solids, building areas
 * given thickness (with the building photo on their front), lights with shadows, and pieces whose
 * motion comes from prepared physics. Objects are rebuilt only when their data changes; every
 * frame sets transforms, light and material values from the layer's time, so any frame can be
 * drawn in any order.
 *
 *   renderScene():      through the show camera, which lines the building front up with the canvas.
 *   renderInspection(): the same scene from an orbiting camera, with the ground grid, the show
 *                       camera's view and the lights marked — for judging depth and shadows.
 *   prepare():          (exports) waits for the building photo and the prepared physics motion.
 */
import {
  type EvaluatedSource,
  eulerDegToQuat,
  evalProp,
  FLICKS_PER_SECOND,
  type Light3D,
  METERS_PER_PIXEL,
  type Object3D,
  PARTICLE_PRESETS,
  PARTICLE_STRIDE,
  particleCapacity,
  type ParticleEmitter,
  particlesAt,
  type ResolvedObject,
  type ResolvedPhysics,
  type ResolvedPiece,
  type ResolvedScene3D,
  placePoint,
  showCamera,
  type Vec3,
} from "@be/core";
import * as THREE from "three/webgpu";
import { type GLTF, GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { ExternalSourceRenderer } from "./compositor.ts";
import type { Gpu } from "./gpu.ts";
import type { PhysicsEngine } from "./physics.ts";
import type { OrbitCamera } from "./venue3d.ts";

export type Scene3DSource = Extract<EvaluatedSource, { kind: "scene3d" }>;

/** A render of a 3D scene. `pending`: physics motion or the photo isn't ready (shown at rest meanwhile). */
export interface SceneRender {
  readonly texture: GPUTexture;
  readonly pending: boolean;
}

interface Entry {
  readonly model: Object3D;
  readonly pieces: readonly ResolvedPiece[];
  readonly meshes: THREE.Mesh[];
  readonly mats: THREE.Material[];
  readonly geos: THREE.BufferGeometry[];
  readonly light?: THREE.Light;
  readonly target?: THREE.Object3D;
  readonly bulb?: THREE.Mesh;
  /** A model from a file: its scene graph, and its animation mixer (set to the layer's time each frame). */
  readonly model3d?: { readonly root: THREE.Object3D; readonly mixer: THREE.AnimationMixer; readonly duration: number; readonly assetId: string } | { readonly pending: string };
  /** Particles: one instanced quad per live particle, refilled every frame. */
  readonly particles?: { readonly mesh: THREE.InstancedMesh; readonly emitter: ParticleEmitter; buf: Float32Array | null };
}

interface Built {
  readonly scene: THREE.Scene;
  readonly showCam: THREE.PerspectiveCamera;
  readonly inspectCam: THREE.PerspectiveCamera;
  readonly entries: Map<string, Entry>;
  readonly helpers: THREE.Object3D[];
  backdrop: THREE.Mesh | null;
  backdropKey: string;
  frustum: THREE.LineSegments | null;
}

const srgb = (c: readonly number[]) => new THREE.Color().setRGB(c[0]!, c[1]!, c[2]!, THREE.SRGBColorSpace);

/** Extruded piece: front faces (group 0, photo) at +depth/2, sides and back (group 1). Local metres. */
const pieceGeometry = (piece: ResolvedPiece, canvasW: number, canvasH: number): THREE.BufferGeometry => {
  const Wm = canvasW * METERS_PER_PIXEL;
  const Hm = canvasH * METERS_PER_PIXEL;
  const d = piece.depth / 2;
  const pos: number[] = [];
  const uv: number[] = [];
  const uvOf = (x: number, y: number) => [(piece.center[0] + x) / Wm + 0.5, 1 - (piece.center[1] + y) / Hm];
  const contour = piece.outline.map((p) => new THREE.Vector2(p[0], p[1]));
  const holes = piece.holes.map((h) => h.map((p) => new THREE.Vector2(p[0], p[1])));
  const tris = THREE.ShapeUtils.triangulateShape(contour, holes);
  const all = [...contour, ...holes.flat()];
  const tri = (a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2, z: number, facing: 1 | -1) => {
    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const [p, q] = (area > 0) === (facing > 0) ? [b, c] : [c, b];
    for (const v of [a, p, q]) {
      pos.push(v.x, v.y, z);
      uv.push(...uvOf(v.x, v.y));
    }
  };
  for (const f of tris) tri(all[f[0]!]!, all[f[1]!]!, all[f[2]!]!, d, 1);
  const frontCount = pos.length / 3;
  for (const f of tris) tri(all[f[0]!]!, all[f[1]!]!, all[f[2]!]!, -d, -1);
  // Sides: each ring edge as a quad facing away from the solid.
  const solidArea = (r: THREE.Vector2[]) => r.reduce((s, v, i) => s + v.x * r[(i + 1) % r.length]!.y - r[(i + 1) % r.length]!.x * v.y, 0);
  const outerCcw = solidArea(contour) > 0;
  const rings: Array<{ r: THREE.Vector2[]; outward: number }> = [{ r: contour, outward: outerCcw ? 1 : -1 }, ...holes.map((h) => ({ r: h, outward: (solidArea(h) > 0 ? 1 : -1) * -1 }))];
  for (const { r, outward } of rings)
    for (let i = 0; i < r.length; i++) {
      const a = r[i]!, b = r[(i + 1) % r.length]!;
      // Outward normal of edge a→b for a CCW ring is (dy, −dx).
      const nx = (b.y - a.y) * outward, ny = -(b.x - a.x) * outward;
      const quad = [
        [a.x, a.y, d], [b.x, b.y, d], [b.x, b.y, -d],
        [a.x, a.y, d], [b.x, b.y, -d], [a.x, a.y, -d],
      ];
      for (let t = 0; t < 6; t += 3) {
        const [p0, p1, p2] = [quad[t]!, quad[t + 1]!, quad[t + 2]!];
        const ux = p1[0]! - p0[0]!, uy = p1[1]! - p0[1]!, uz = p1[2]! - p0[2]!;
        const vx = p2[0]! - p0[0]!, vy = p2[1]! - p0[1]!, vz = p2[2]! - p0[2]!;
        const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz;
        const ordered = cx * nx + cy * ny >= 0 ? [p0, p1, p2] : [p0, p2, p1];
        for (const v of ordered) {
          pos.push(v[0]!, v[1]!, v[2]!);
          uv.push(0.5, 0.5);
        }
      }
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  g.addGroup(0, frontCount, 0);
  g.addGroup(frontCount, pos.length / 3 - frontCount, 1);
  return g;
};

const tmp = new THREE.Object3D();
const tmpColor = new THREE.Color();

/** Round soft-edged sprites: "glow" (bright core, long falloff, for sparks and embers) or "soft" (a flake). */
const sprites = new Map<string, THREE.DataTexture>();
const spriteTexture = (kind: "glow" | "soft"): THREE.DataTexture => {
  let t = sprites.get(kind);
  if (t) return t;
  const n = 64;
  const px = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const r = Math.hypot((x + 0.5) / n - 0.5, (y + 0.5) / n - 0.5) * 2;
      const a = kind === "glow" ? Math.max(0, Math.exp(-r * r * 6) - Math.exp(-6)) / (1 - Math.exp(-6)) : Math.min(1, Math.max(0, (1 - r) * 3));
      const i = (y * n + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = 255;
      px[i + 3] = Math.round(a * 255);
    }
  t = new THREE.DataTexture(px, n, n, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  sprites.set(kind, t);
  return t;
};

const primitiveGeometry = (o: Object3D): THREE.BufferGeometry | null => {
  const g = o.geometry;
  if (!g) return null;
  if (g.kind === "box") return new THREE.BoxGeometry(g.size[0], g.size[1], g.size[2]);
  if (g.kind === "sphere") return new THREE.SphereGeometry(g.radius, 32, 20);
  if (g.kind === "plane") return new THREE.PlaneGeometry(g.size[0], g.size[1]);
  return null;
};

export class SceneHost implements ExternalSourceRenderer {
  private renderer!: THREE.WebGPURenderer;
  private readonly built = new Map<string, Built>();
  private readonly targets = new Map<string, THREE.RenderTarget>();
  private readonly photos = new Map<string, THREE.Texture | null>();
  private readonly photoLoading = new Map<string, Promise<void>>();
  /** Prepared physics motion (set by the renderer). */
  physics: PhysicsEngine | null = null;
  /** Loads an image asset (the building photo) for textures; set by the host app. */
  imageSource: ((assetId: string) => Promise<ImageBitmap | null>) | null = null;
  /** Loads a model asset's file (GLB) for 3D scenes; set by the host app. */
  modelSource: ((assetId: string) => Promise<Uint8Array | null>) | null = null;
  private readonly models = new Map<string, GLTF | null>();
  private readonly modelLoading = new Map<string, Promise<void>>();
  /** Called when something arrives that changes a render (photo loaded). */
  onChange: (() => void) | null = null;

  private constructor(private readonly gpu: Gpu) {}

  static async create(gpu: Gpu): Promise<SceneHost> {
    const host = new SceneHost(gpu);
    host.renderer = new THREE.WebGPURenderer({ device: gpu.device, antialias: true, alpha: true } as ConstructorParameters<typeof THREE.WebGPURenderer>[0]);
    await host.renderer.init();
    host.renderer.shadowMap.enabled = true;
    host.renderer.toneMapping = THREE.NoToneMapping;
    host.renderer.setClearColor(0x000000, 0);
    return host;
  }

  private photo(assetId: string | undefined): THREE.Texture | null | undefined {
    if (!assetId) return null;
    if (this.photos.has(assetId)) return this.photos.get(assetId);
    if (!this.photoLoading.has(assetId) && this.imageSource) {
      const p = this.imageSource(assetId)
        .then((bmp) => {
          if (!bmp) {
            this.photos.set(assetId, null);
            return;
          }
          const t = new THREE.Texture(bmp);
          t.colorSpace = THREE.SRGBColorSpace;
          t.flipY = false;
          t.anisotropy = 8;
          t.needsUpdate = true;
          this.photos.set(assetId, t);
        })
        .catch(() => void this.photos.set(assetId, null))
        .finally(() => {
          this.photoLoading.delete(assetId);
          this.onChange?.();
        });
      this.photoLoading.set(assetId, p);
    }
    return undefined;
  }

  /** A model's parsed file (undefined while loading, null if it couldn't be read). */
  private model(assetId: string): GLTF | null | undefined {
    if (this.models.has(assetId)) return this.models.get(assetId);
    if (!this.modelLoading.has(assetId) && this.modelSource) {
      const p = this.modelSource(assetId)
        .then(async (bytes) => {
          if (!bytes) {
            this.models.set(assetId, null);
            return;
          }
          const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
          const gltf = await new GLTFLoader().parseAsync(buf, "");
          this.models.set(assetId, gltf);
        })
        .catch(() => void this.models.set(assetId, null))
        .finally(() => {
          this.modelLoading.delete(assetId);
          this.onChange?.();
        });
      this.modelLoading.set(assetId, p);
    }
    return undefined;
  }

  /** First frame at which this scene's prepared motion is needed. */
  private static firstMoving(p: ResolvedPhysics): number {
    let f = Infinity;
    for (const b of p.bodies) {
      if (b.poseIndex < 0) continue;
      f = Math.min(f, b.kind === "fragment" ? (b.release ?? 0) : 0);
    }
    return f;
  }

  /** Exports: wait for the photo and the prepared motion this frame needs. */
  async prepare(src: Scene3DSource): Promise<void> {
    const r = src.resolved;
    if (!r) return;
    if (r.photoAssetId && r.objects.some((o) => o.object.material?.style === "photo")) {
      this.photo(r.photoAssetId);
      await this.photoLoading.get(r.photoAssetId);
    }
    for (const o of r.objects) {
      const id = o.object.material?.style === "image" ? o.object.material.assetId : undefined;
      if (!id) continue;
      this.photo(id);
      await this.photoLoading.get(id);
    }
    for (const o of r.objects) {
      if (o.object.geometry?.kind !== "model") continue;
      this.model(o.object.geometry.assetId);
      await this.modelLoading.get(o.object.geometry.assetId);
    }
    if (r.physics && src.frame >= SceneHost.firstMoving(r.physics)) {
      if (!this.physics) throw new Error("Physics can't be prepared here.");
      await this.physics.ensure(r.physics);
    }
  }

  private buildScene(id: string): Built {
    let b = this.built.get(id);
    if (b) return b;
    const scene = new THREE.Scene();
    const grid = new THREE.GridHelper(40, 40, 0x3a4250, 0x232a35);
    const helpers: THREE.Object3D[] = [grid];
    scene.add(grid);
    b = { scene, showCam: new THREE.PerspectiveCamera(30, 16 / 9, 0.05, 500), inspectCam: new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 500), entries: new Map(), helpers, backdrop: null, backdropKey: "", frustum: null };
    this.built.set(id, b);
    return b;
  }

  private dropEntry(b: Built, e: Entry) {
    if (e.model3d && "root" in e.model3d) {
      b.scene.remove(e.model3d.root);
      e.model3d.mixer.stopAllAction();
    }
    for (const m of e.meshes) b.scene.remove(m);
    if (e.light) b.scene.remove(e.light);
    if (e.target) b.scene.remove(e.target);
    if (e.bulb) b.scene.remove(e.bulb);
    for (const g of e.geos) g.dispose();
    for (const m of e.mats) m.dispose();
    if (e.light) (e.light as THREE.DirectionalLight).shadow?.map?.dispose();
  }

  private makeEntry(b: Built, r: ResolvedScene3D, ro: ResolvedObject): Entry {
    const o = ro.object;
    if (o.geometry?.kind === "model") {
      const assetId = o.geometry.assetId;
      const gltf = this.model(assetId);
      if (!gltf) return { model: o, pieces: ro.pieces, meshes: [], mats: [], geos: [], model3d: { pending: assetId } };
      // Each use gets its own copy (skinned meshes keep their bones), so one file can appear twice.
      const root = cloneSkinned(gltf.scene);
      root.traverse((x) => {
        if ((x as THREE.Mesh).isMesh) {
          (x as THREE.Mesh).castShadow = o.castShadow ?? true;
          (x as THREE.Mesh).receiveShadow = o.receiveShadow ?? true;
        }
      });
      const mixer = new THREE.AnimationMixer(root);
      let duration = 0;
      for (const clip of gltf.animations) {
        mixer.clipAction(clip).play();
        duration = Math.max(duration, clip.duration);
      }
      b.scene.add(root);
      return { model: o, pieces: ro.pieces, meshes: [], mats: [], geos: [], model3d: { root, mixer, duration, assetId } };
    }
    if (o.kind === "particles" && o.particles && ro.emitter) {
      const p = o.particles;
      const glow = PARTICLE_PRESETS[p.kind].glow;
      const geo = new THREE.PlaneGeometry(1, 1);
      const mat =
        p.kind === "confetti"
          ? new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false })
          : new THREE.MeshBasicMaterial({ map: spriteTexture(glow ? "glow" : "soft"), transparent: true, depthWrite: false, blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending, toneMapped: false });
      const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, particleCapacity(p, ro.emitter)));
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, new THREE.Color(1, 1, 1));
      // Rewritten every frame, like the matrices (also makes the very first frame use them).
      mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      b.scene.add(mesh);
      return { model: o, pieces: ro.pieces, meshes: [mesh], mats: [mat], geos: [geo], particles: { mesh, emitter: ro.emitter, buf: null } };
    }
    if (o.kind === "light" && o.light) {
      const L = o.light;
      let light: THREE.Light;
      let target: THREE.Object3D | undefined;
      if (L.type === "ambient") light = new THREE.HemisphereLight(srgb(L.color), srgb(L.color.map((c) => c * 0.3)), 1);
      else if (L.type === "point") light = new THREE.PointLight(srgb(L.color), 1, 0, 2);
      else {
        const l = L.type === "spot" ? new THREE.SpotLight(srgb(L.color), 1, 0, (L.angle * Math.PI) / 180, L.softness, 2) : new THREE.DirectionalLight(srgb(L.color), 1);
        target = new THREE.Object3D();
        b.scene.add(target);
        l.target = target;
        light = l;
      }
      if (L.castShadow && "shadow" in light && light.shadow) {
        light.castShadow = true;
        const sh = light.shadow as THREE.DirectionalLightShadow;
        sh.mapSize.set(2048, 2048);
        sh.bias = -0.0004;
        sh.normalBias = 0.02;
        sh.radius = 1 + L.softness * 6;
        if (light instanceof THREE.DirectionalLight) {
          const R = Math.max(r.canvas.width, r.canvas.height) * METERS_PER_PIXEL * 0.8 + 2;
          Object.assign(sh.camera, { left: -R, right: R, top: R, bottom: -R, near: 0.1, far: 200 });
          sh.camera.updateProjectionMatrix();
        }
      }
      b.scene.add(light);
      let bulb: THREE.Mesh | undefined;
      if (L.type !== "ambient") {
        const bm = new THREE.MeshBasicMaterial({ color: 0xffd27a });
        bulb = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 10), bm);
        bulb.userData.inspectOnly = true;
        b.scene.add(bulb);
        return { model: o, pieces: ro.pieces, meshes: [], mats: [bm], geos: [bulb.geometry], light, ...(target ? { target } : {}), bulb };
      }
      return { model: o, pieces: ro.pieces, meshes: [], mats: [], geos: [], light, ...(target ? { target } : {}) };
    }
    const m = o.material;
    const mats: THREE.Material[] = [];
    let front: THREE.Material;
    let side: THREE.Material;
    if (m?.style === "shadow") {
      front = side = new THREE.ShadowMaterial({ opacity: m.opacity, color: 0x000000 });
      mats.push(front);
    } else {
      const base = { roughness: m?.roughness ?? 0.8, metalness: m?.metalness ?? 0, transparent: (m?.opacity ?? 1) < 1, opacity: m?.opacity ?? 1 };
      front = new THREE.MeshStandardMaterial(base);
      if (m?.style === "image" && m.assetId) {
        // A picture on the front (e.g. what's seen through an opening); the sides stay plain.
        front.userData.image = m.assetId;
        side = new THREE.MeshStandardMaterial(base);
        side.userData.sideOf = true;
        mats.push(front, side);
      } else if (m?.style === "photo") {
        front.userData.photo = true;
        side = new THREE.MeshStandardMaterial(base);
        side.userData.sideOf = true;
        mats.push(front, side);
      } else {
        side = front;
        mats.push(front);
      }
    }
    const geos: THREE.BufferGeometry[] = [];
    const meshes: THREE.Mesh[] = [];
    if (o.geometry?.kind === "area")
      for (const p of ro.pieces) {
        const g = pieceGeometry(p, r.canvas.width, r.canvas.height);
        geos.push(g);
        meshes.push(new THREE.Mesh(g, [front, side]));
      }
    else {
      const g = primitiveGeometry(o);
      if (g) {
        geos.push(g);
        if (m?.style === "image") {
          // Pictures load top row first (not flipped): turn the face coordinates to match.
          const uv = g.getAttribute("uv");
          for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
          // A box's faces in order: +x, −x, +y, −y, +z (front), −z.
          meshes.push(new THREE.Mesh(g, g.groups.length === 6 ? [side, side, side, side, front, side] : front));
        } else meshes.push(new THREE.Mesh(g, front));
      }
    }
    for (const mesh of meshes) {
      mesh.castShadow = (o.castShadow ?? true) && m?.style !== "shadow";
      mesh.receiveShadow = o.receiveShadow ?? true;
      b.scene.add(mesh);
    }
    return { model: o, pieces: ro.pieces, meshes, mats, geos };
  }

  /** Bring the three.js scene up to date with the data and set everything for this frame. */
  private update(src: Scene3DSource): { b: Built; pending: boolean } | null {
    const r = src.resolved;
    if (!r) return null;
    const b = this.buildScene(r.scene.id);
    const seen = new Set<string>();
    for (const ro of r.objects) {
      seen.add(ro.object.id);
      const e0 = b.entries.get(ro.object.id);
      // A model that has finished loading since its entry was made: build it now.
      const e = e0?.model3d && "pending" in e0.model3d && this.models.get(e0.model3d.pending) ? (this.dropEntry(b, e0), undefined) : e0;
      const sameEmitter = !e?.particles || e.particles.emitter === ro.emitter;
      if (e && e.model === ro.object && e.pieces === ro.pieces && sameEmitter) continue;
      // Only these change the built objects; transforms and values are set per frame below.
      if (e && e.pieces === ro.pieces && sameEmitter && sameBuild(e.model, ro.object)) {
        b.entries.set(ro.object.id, { ...e, model: ro.object });
        continue;
      }
      if (e) this.dropEntry(b, e);
      b.entries.set(ro.object.id, this.makeEntry(b, r, ro));
    }
    for (const [id, e] of b.entries)
      if (!seen.has(id)) {
        this.dropEntry(b, e);
        b.entries.delete(id);
      }

    let pending = false;
    const photo = this.photo(r.photoAssetId);
    const t = src.localTime;
    const physics = r.physics;
    const motion = physics && this.physics ? this.physics.motion(physics.key) : null;
    for (const ro of r.objects) {
      const e = b.entries.get(ro.object.id)!;
      const o = e.model;
      const pos = evalProp(o.position, t);
      const rot = evalProp(o.rotation, t);
      const scl = evalProp(o.scale, t).map((s) => s / 100) as unknown as Vec3;
      const q = eulerDegToQuat(rot);
      if (e.light && o.light) {
        const L: Light3D = o.light;
        const k = evalProp(L.intensity, t);
        e.light.intensity = L.type === "spot" || L.type === "point" ? k * 50 : k;
        // A soft fill (hemisphere light) takes its "up" direction from its position: keep it straight up.
        if (L.type === "ambient") e.light.position.set(0, 1, 0);
        else e.light.position.set(pos[0], pos[1], pos[2]);
        e.light.visible = o.visible;
        e.target?.position.set(L.target[0], L.target[1], L.target[2]);
        e.target?.updateMatrixWorld();
        e.bulb?.position.set(pos[0], pos[1], pos[2]);
        continue;
      }
      if (e.particles && o.particles) {
        // Where every live particle is at this moment (worked out from time, nothing stepped).
        const P = e.particles;
        const { count, data } = particlesAt(o.particles, P.emitter, t / FLICKS_PER_SECOND, P.buf ?? undefined);
        P.buf = data;
        const m = P.mesh;
        const n = Math.min(count, m.instanceMatrix.count);
        const glow = PARTICLE_PRESETS[o.particles.kind].glow;
        for (let i = 0; i < n; i++) {
          const k = i * PARTICLE_STRIDE;
          const size = data[k + 3]!;
          tmp.position.set(data[k]!, data[k + 1]!, data[k + 2]!);
          tmp.rotation.set(data[k + 9]!, 0, data[k + 8]!, "ZXY");
          tmp.scale.set(size * data[k + 10]!, size, 1);
          tmp.updateMatrix();
          m.setMatrixAt(i, tmp.matrix);
          // Glowing particles fade by dimming (they add light); the others keep their colour.
          const a = glow ? data[k + 7]! : 1;
          m.setColorAt(i, tmpColor.setRGB(data[k + 4]! * a, data[k + 5]! * a, data[k + 6]! * a, THREE.SRGBColorSpace));
        }
        m.count = n;
        m.visible = o.visible;
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
        continue;
      }
      // Materials.
      const m = o.material;
      for (const mat of e.mats) {
        if (mat instanceof THREE.MeshStandardMaterial && m) {
          const c = evalProp(m.color, t);
          mat.color.copy(srgb(c));
          if (mat.userData.sideOf) mat.color.multiplyScalar(0.55);
          const glow = evalProp(m.glow, t);
          mat.emissive.copy(srgb(c));
          mat.emissiveIntensity = glow;
          if (mat.userData.photo) {
            if (photo && mat.map !== photo) {
              mat.map = photo;
              mat.needsUpdate = true;
            } else if (photo === undefined && r.photoAssetId) pending = true;
          }
          if (mat.userData.image) {
            const img = this.photo(mat.userData.image as string);
            if (img && mat.map !== img) {
              mat.map = img;
              mat.needsUpdate = true;
            } else if (img === undefined) pending = true;
          }
        }
      }
      if (e.model3d) {
        if ("pending" in e.model3d) {
          if (this.models.get(e.model3d.pending) === undefined) pending = true;
          continue;
        }
        // Placed by the object's transform; the file's own animation follows the layer's time.
        const { root, mixer } = e.model3d;
        root.visible = o.visible;
        root.position.set(pos[0], pos[1], pos[2]);
        root.quaternion.set(q[0], q[1], q[2], q[3]);
        root.scale.set(scl[0], scl[1], scl[2]);
        const clip = o.clip ?? { speed: 1, offset: 0 };
        mixer.setTime(Math.max(0, (t / FLICKS_PER_SECOND) * clip.speed + clip.offset));
        continue;
      }
      // Pieces: from prepared motion once they move, otherwise placed with the object.
      const moving = ro.poseIndex >= 0 && physics;
      const needMotion = moving && src.frame >= SceneHost.firstMoving(physics);
      const haveMotion = !!motion && motion.ready > src.frame;
      if (needMotion && !haveMotion) pending = true;
      const list = e.pieces.length ? e.pieces : [null];
      list.forEach((piece, i) => {
        const mesh = e.meshes[i];
        if (!mesh) return;
        mesh.visible = o.visible;
        mesh.scale.set(scl[0], scl[1], scl[2]);
        if (needMotion && haveMotion) {
          const off = (src.frame * physics.movers + ro.poseIndex + i) * 7;
          const d = motion.data;
          mesh.position.set(d[off]!, d[off + 1]!, d[off + 2]!);
          mesh.quaternion.set(d[off + 3]!, d[off + 4]!, d[off + 5]!, d[off + 6]!);
        } else {
          const c = piece ? piece.center : ([0, 0, 0] as Vec3);
          const w = placePoint(c, pos, q, scl, o.pivot);
          mesh.position.set(w[0], w[1], w[2]);
          mesh.quaternion.set(q[0], q[1], q[2], q[3]);
        }
      });
    }
    return { b, pending };
  }

  private target(key: string, w: number, h: number): THREE.RenderTarget {
    let rt = this.targets.get(key);
    if (!rt || rt.width !== w || rt.height !== h) {
      rt?.dispose();
      rt = new THREE.RenderTarget(w, h, { type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace, samples: 4, depthBuffer: true });
      this.targets.set(key, rt);
    }
    return rt;
  }

  private draw(key: string, scene: THREE.Scene, camera: THREE.Camera, width: number, height: number): GPUTexture | null {
    const rt = this.target(key, width, height);
    this.renderer.setRenderTarget(rt);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    const src = (this.renderer.backend as unknown as { get(o: object): { texture?: GPUTexture } }).get(rt.texture).texture;
    if (!src) return null;
    // three.js has already submitted its commands; copy now so a second render of the same scene
    // in this frame can't overwrite what the compositor will read.
    const copy = this.gpu.device.createTexture({ label: `scene:${key}`, size: [src.width, src.height], format: src.format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
    const enc = this.gpu.device.createCommandEncoder();
    enc.copyTextureToTexture({ texture: src }, { texture: copy }, [src.width, src.height]);
    this.gpu.device.queue.submit([enc.finish()]);
    this.gpu.defer(copy);
    return copy;
  }

  private setInspectOnly(b: Built, on: boolean) {
    for (const h of b.helpers) h.visible = on;
    if (b.backdrop) b.backdrop.visible = on;
    if (b.frustum) b.frustum.visible = on;
    for (const e of b.entries.values()) if (e.bulb) e.bulb.visible = on && e.model.visible;
    b.scene.background = on ? new THREE.Color(0x0b0d12) : null;
  }

  /** Render through the show camera (lined up with the canvas), for the composition. */
  renderScene(src: Scene3DSource, width: number, height: number): SceneRender | null {
    const u = this.update(src);
    if (!u) return null;
    const { b } = u;
    const r = src.resolved!;
    const cam = showCamera(r.canvas, r.scene.cameraDistance);
    b.showCam.fov = cam.fovY;
    b.showCam.aspect = cam.aspect;
    b.showCam.near = 0.05;
    b.showCam.far = 500;
    b.showCam.position.set(cam.eye[0], cam.eye[1], cam.eye[2]);
    b.showCam.lookAt(cam.target[0], cam.target[1], cam.target[2]);
    b.showCam.updateProjectionMatrix();
    this.setInspectOnly(b, false);
    const texture = this.draw(`show:${r.scene.id}`, b.scene, b.showCam, width, height);
    return texture ? { texture, pending: u.pending } : null;
  }

  /** Render from an orbiting inspection camera, with the grid, the show camera's view and lights marked. */
  renderInspection(src: Scene3DSource, orbit: OrbitCamera, width: number, height: number): SceneRender | null {
    const u = this.update(src);
    if (!u) return null;
    const { b } = u;
    const r = src.resolved!;
    const Wm = r.canvas.width * METERS_PER_PIXEL;
    const Hm = r.canvas.height * METERS_PER_PIXEL;
    // The building photo far behind everything, for orientation.
    const key = `${r.photoAssetId}|${Wm}x${Hm}`;
    const photo = this.photo(r.photoAssetId);
    if (b.backdropKey !== key || (photo && !(b.backdrop?.material as THREE.MeshBasicMaterial | undefined)?.map)) {
      if (b.backdrop) {
        b.scene.remove(b.backdrop);
        b.backdrop.geometry.dispose();
        (b.backdrop.material as THREE.Material).dispose();
      }
      const mat = new THREE.MeshBasicMaterial({ color: srgb([0.35, 0.35, 0.35]), ...(photo ? { map: photo } : {}) });
      b.backdrop = new THREE.Mesh(new THREE.PlaneGeometry(Wm, Hm), mat);
      b.backdrop.position.set(0, Hm / 2, -2.5);
      b.scene.add(b.backdrop);
      b.backdropKey = key;
    }
    // The show camera's view as lines.
    const cam = showCamera(r.canvas, r.scene.cameraDistance);
    if (!b.frustum) {
      b.frustum = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffc46b, transparent: true, opacity: 0.6 }));
      b.scene.add(b.frustum);
    }
    const e = cam.eye;
    const corners: Vec3[] = [[-Wm / 2, 0, 0], [Wm / 2, 0, 0], [Wm / 2, Hm, 0], [-Wm / 2, Hm, 0]];
    const pts: number[] = [];
    for (const c of corners) pts.push(...e, ...c);
    for (let i = 0; i < 4; i++) pts.push(...corners[i]!, ...corners[(i + 1) % 4]!);
    b.frustum.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    // Orbit camera around the middle of the building front.
    const target = [orbit.panX * Wm, Hm / 2 + orbit.panY * Wm, -0.3];
    const yaw = (orbit.yaw * Math.PI) / 180;
    const pitch = (Math.max(-5, Math.min(85, orbit.pitch)) * Math.PI) / 180;
    const dist = Math.max(0.2, orbit.distance) * Wm;
    b.inspectCam.aspect = width / height;
    b.inspectCam.fov = 40;
    b.inspectCam.position.set(target[0]! + dist * Math.sin(yaw) * Math.cos(pitch), target[1]! + dist * Math.sin(pitch), target[2]! + dist * Math.cos(yaw) * Math.cos(pitch));
    b.inspectCam.lookAt(target[0]!, target[1]!, target[2]!);
    b.inspectCam.updateProjectionMatrix();
    this.setInspectOnly(b, true);
    const texture = this.draw(`inspect:${r.scene.id}`, b.scene, b.inspectCam, width, height);
    this.setInspectOnly(b, false);
    return texture ? { texture, pending: u.pending } : null;
  }
}

/** Whether two versions of an object need the same three.js objects (only values differ). */
const sameBuild = (a: Object3D, b: Object3D): boolean =>
  a.kind === b.kind &&
  (a.geometry?.kind === "model") === (b.geometry?.kind === "model") &&
  a.particles === b.particles &&
  a.geometry === b.geometry &&
  a.castShadow === b.castShadow &&
  a.receiveShadow === b.receiveShadow &&
  a.material?.style === b.material?.style &&
  a.material?.assetId === b.material?.assetId &&
  a.material?.roughness === b.material?.roughness &&
  a.material?.metalness === b.material?.metalness &&
  a.material?.opacity === b.material?.opacity &&
  a.light?.type === b.light?.type &&
  a.light?.castShadow === b.light?.castShadow &&
  a.light?.angle === b.light?.angle &&
  a.light?.softness === b.light?.softness &&
  JSON.stringify(a.light?.color) === JSON.stringify(b.light?.color);
