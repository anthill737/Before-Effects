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
  activeAt,
  type CameraNow,
  objectPose,
  balancesPicture,
  type EvaluatedSource,
  eulerDegToQuat,
  evalProp,
  blockPose,
  FLICKS_PER_SECOND,
  frontIrradiance,
  isPieced,
  type Light3D,
  type LightNow,
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
  pictureGain,
  pictureMix,
  placePoint,
  showCamera,
  type Vec3,
} from "@be/core";
import * as THREE from "three/webgpu";
import { attribute, materialColor, materialEmissive, positionWorld, step, texture, uniform, vec2, vec4 } from "three/tsl";
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
  /** Shadow-map sizes asked for recently (size, when), see fitShadows. */
  shadowAsks: Array<[number, number]>;
  /** The scene camera's view-projection, for pictures projected through it (Material3D mapping "camera"). */
  readonly projector: ReturnType<typeof projectorUniform>;
  /** The scene's own camera this frame (null: the show camera). */
  cam: CameraNow | null;
}

/**
 * Shadow-map size for a render this tall: full detail (2048) at 1080 px and above, less for smaller
 * previews (1024 at half, 512 at a quarter). A shadow map costs the same whatever the picture's
 * size, and a point light draws six, so small previews (and preparing them) don't pay for detail
 * they can't show. Exports render full size: full detail.
 */
export const shadowMapSize = (height: number): number => {
  const want = 2048 * Math.min(1, height / 1080);
  let s = 512;
  while (s < want && s < 2048) s *= 2;
  return s;
};

const srgb = (c: readonly number[]) => new THREE.Color().setRGB(c[0]!, c[1]!, c[2]!, THREE.SRGBColorSpace);

/**
 * Extruded piece: front faces (group 0, photo) at +depth/2, sides and back (group 1). Local metres.
 * Its picture coordinates: across the canvas (a traced area), or across `frame` (a panel: its whole
 * outline, x0 y0 x1 y1). "home": each point where it is at rest in its object's space, for a picture
 * projected through the camera that the pieces carry with them.
 */
const pieceGeometry = (piece: ResolvedPiece, canvasW: number, canvasH: number, frame?: readonly [number, number, number, number]): THREE.BufferGeometry => {
  const Wm = canvasW * METERS_PER_PIXEL;
  const Hm = canvasH * METERS_PER_PIXEL;
  const d = piece.depth / 2;
  const pos: number[] = [];
  const uv: number[] = [];
  const uvOf = frame
    ? (x: number, y: number) => [(piece.center[0] + x - frame[0]) / (frame[2] - frame[0] || 1), 1 - (piece.center[1] + y - frame[1]) / (frame[3] - frame[1] || 1)]
    : (x: number, y: number) => [(piece.center[0] + x) / Wm + 0.5, 1 - (piece.center[1] + y) / Hm];
  const contour = piece.outline.map((p) => new THREE.Vector2(p[0], p[1]));
  const holes = piece.holes.map((h) => h.map((p) => new THREE.Vector2(p[0], p[1])));
  const tris = THREE.ShapeUtils.triangulateShape(contour, holes);
  const all = [...contour, ...holes.flat()];
  // A piece standing out along the camera's lines of sight has a slightly larger back face.
  const bk = piece.back;
  const atBack = (x: number, y: number): [number, number] => (bk ? [x * bk.scale + bk.shift[0], y * bk.scale + bk.shift[1]] : [x, y]);
  const tri = (a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2, z: number, facing: 1 | -1) => {
    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const [p, q] = (area > 0) === (facing > 0) ? [b, c] : [c, b];
    for (const v of [a, p, q]) {
      const [x, y] = facing > 0 ? [v.x, v.y] : atBack(v.x, v.y);
      pos.push(x, y, z);
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
      const [abx, aby] = atBack(a.x, a.y), [bbx, bby] = atBack(b.x, b.y);
      const quad = [
        [a.x, a.y, d], [b.x, b.y, d], [bbx, bby, -d],
        [a.x, a.y, d], [bbx, bby, -d], [abx, aby, -d],
      ];
      for (let t = 0; t < 6; t += 3) {
        const [p0, p1, p2] = [quad[t]!, quad[t + 1]!, quad[t + 2]!];
        const ux = p1[0]! - p0[0]!, uy = p1[1]! - p0[1]!, uz = p1[2]! - p0[2]!;
        const vx = p2[0]! - p0[0]!, vy = p2[1]! - p0[1]!, vz = p2[2]! - p0[2]!;
        const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz;
        const ordered = cx * nx + cy * ny >= 0 ? [p0, p1, p2] : [p0, p2, p1];
        for (const v of ordered) {
          pos.push(v[0]!, v[1]!, v[2]!);
          // The picture straight through the solid: a side shows the picture at that edge (the front
          // edge's spot, however the back tapers).
          const front = v[2]! > 0 ? [v[0]!, v[1]!] : bk ? [(v[0]! - bk.shift[0]) / bk.scale, (v[1]! - bk.shift[1]) / bk.scale] : [v[0]!, v[1]!];
          uv.push(...uvOf(front[0]!, front[1]!));
        }
      }
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("home", new THREE.Float32BufferAttribute(pos.map((v, i) => v + piece.center[i % 3]!), 3));
  g.computeVertexNormals();
  g.addGroup(0, frontCount, 0);
  g.addGroup(frontCount, pos.length / 3 - frontCount, 1);
  return g;
};

const tmp = new THREE.Object3D();
const tmpColor = new THREE.Color();
const tmpQ = new THREE.Quaternion();
const blockQ = new THREE.Quaternion();
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** The scene camera's view-projection (set every frame), for pictures projected through it. */
const projectorUniform = () => uniform(new THREE.Matrix4());

/** A panel's picture frame: its outline's extent (x0, y0, x1, y1). */
const panelFrame = (outline: readonly (readonly [number, number])[]): [number, number, number, number] => {
  const xs = outline.map((p) => p[0]), ys = outline.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

/** Where an object's points are at the layer's start (its own space -> scene), as a matrix. */
const restMatrix = (out: THREE.Matrix4, scene: ResolvedScene3D["scene"], o: Object3D): void => {
  const pose = objectPose(scene, o, 0);
  const c = pose.place([0, 0, 0]);
  const ax = pose.place([1, 0, 0]), ay = pose.place([0, 1, 0]), az = pose.place([0, 0, 1]);
  out.set(ax[0] - c[0], ay[0] - c[0], az[0] - c[0], c[0], ax[1] - c[1], ay[1] - c[1], az[1] - c[1], c[1], ax[2] - c[2], ay[2] - c[2], az[2] - c[2], c[2], 0, 0, 0, 1);
};

/** A 1×1 black picture standing in until a projected picture has loaded. */
let blank: THREE.DataTexture | null = null;
const placeholder = (): THREE.DataTexture => {
  if (!blank) {
    blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
    blank.needsUpdate = true;
  }
  return blank;
};

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
  /**
   * When each render target and built scene was last used. Unused ones are freed (a target after a
   * few seconds, a scene after a minute) so graphics memory follows what's being shown, not every
   * 3D layer a long show has passed through (each target is ~80 MB at 1080p).
   */
  private readonly targetUsed = new Map<string, number>();
  private readonly builtUsed = new Map<string, number>();
  private lastSweep = 0;
  private readonly photos = new Map<string, THREE.Texture | null>();
  private readonly photoLoading = new Map<string, Promise<void>>();
  /** Prepared physics motion (set by the renderer). */
  physics: PhysicsEngine | null = null;
  /** Loads an image asset (the building photo) for textures; set by the host app. */
  imageSource: ((assetId: string) => Promise<ImageBitmap | null>) | null = null;
  /** Loads a model asset's file (GLB) for 3D scenes; set by the host app. */
  modelSource: ((assetId: string) => Promise<Uint8Array | null>) | null = null;
  private readonly models = new Map<string, GLTF | null>();
  /** Models that couldn't be read, with why (for the 3D panel and the agent API). */
  readonly modelErrors = new Map<string, string>();
  /** Told when a model can't be read (the app logs it). */
  onModelError: ((assetId: string, message: string) => void) | null = null;
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
          if (!bytes) throw new Error("the file is missing or unreadable");
          const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
          const gltf = await new GLTFLoader().parseAsync(buf, "");
          this.models.set(assetId, gltf);
          this.modelErrors.delete(assetId);
        })
        .catch((e: unknown) => {
          const msg = String((e as Error)?.message ?? e);
          const why = /draco|meshopt|ktx2|basis/i.test(msg)
            ? "it uses compression this app can't read yet (Draco, Meshopt or KTX2): export it again without compression"
            : /fetch|load|uri|url|resource/i.test(msg)
              ? "it refers to other files (textures or .bin): export it as a single .glb file"
              : msg;
          this.models.set(assetId, null);
          this.modelErrors.set(assetId, why);
          this.onModelError?.(assetId, why);
        })
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
    this.builtUsed.set(id, performance.now());
    let b = this.built.get(id);
    if (b) return b;
    const scene = new THREE.Scene();
    const grid = new THREE.GridHelper(40, 40, 0x3a4250, 0x232a35);
    const helpers: THREE.Object3D[] = [grid];
    scene.add(grid);
    b = { scene, showCam: new THREE.PerspectiveCamera(30, 16 / 9, 0.05, 500), inspectCam: new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 500), entries: new Map(), helpers, backdrop: null, backdropKey: "", frustum: null, shadowAsks: [], projector: projectorUniform(), cam: null };
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
      // Only some of its parts (Geometry3D model nodes): the others are left out.
      const keep = o.geometry.nodes;
      if (keep?.length) for (const child of [...root.children]) if (!keep.includes(child.name)) root.remove(child);
      // A material of this app's own (e.g. the picture projected through the scene's camera) instead of the file's.
      const own = o.material ? this.makeMaterials(b, o) : null;
      root.traverse((x) => {
        if ((x as THREE.Mesh).isMesh) {
          (x as THREE.Mesh).castShadow = (o.castShadow ?? true) && o.material?.style !== "shadow";
          (x as THREE.Mesh).receiveShadow = o.receiveShadow ?? true;
          if (own) (x as THREE.Mesh).material = own.front;
        }
      });
      const mixer = new THREE.AnimationMixer(root);
      let duration = 0;
      for (const clip of gltf.animations) {
        mixer.clipAction(clip).play();
        duration = Math.max(duration, clip.duration);
      }
      b.scene.add(root);
      return { model: o, pieces: ro.pieces, meshes: [], mats: own?.mats ?? [], geos: [], model3d: { root, mixer, duration, assetId } };
    }
    if (o.kind === "null") {
      // A controller: nothing drawn (a small marker in the inspection view only).
      const bm = new THREE.MeshBasicMaterial({ color: 0x7fd3ff, wireframe: true });
      const marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.22), bm);
      marker.userData.inspectOnly = true;
      b.scene.add(marker);
      return { model: o, pieces: ro.pieces, meshes: [], mats: [bm], geos: [marker.geometry], bulb: marker };
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
        } else {
          // A point or spot light can be right up against what it lights (a lantern by a column); its
          // shadow map is a cube of distances, so a small filter and its own bias.
          Object.assign(sh.camera, { near: 0.05, far: 60 });
          sh.camera.updateProjectionMatrix();
          sh.radius = 1 + L.softness * 2;
          sh.bias = -0.002;
          sh.normalBias = 0.03;
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
    const { front, side, mats } = this.makeMaterials(b, o);
    const m = o.material;
    const geos: THREE.BufferGeometry[] = [];
    const meshes: THREE.Mesh[] = [];
    if (isPieced(o.geometry)) {
      const frame = o.geometry.kind === "panel" ? panelFrame(o.geometry.outline) : undefined;
      for (const p of ro.pieces) {
        const g = pieceGeometry(p, r.canvas.width, r.canvas.height, frame);
        geos.push(g);
        meshes.push(new THREE.Mesh(g, [front, side]));
      }
    } else {
      const g = primitiveGeometry(o);
      if (g) {
        geos.push(g);
        if (m?.style === "image" && m.mapping !== "camera") {
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

  /**
   * An object's materials: its front (the picture, for picture styles) and sides. A picture projected
   * through the scene's camera (mapping "camera") is worked out per point from where that camera
   * sees it, so it lines up exactly on any surface at any depth or angle; its transparent parts give
   * no colour.
   */
  private makeMaterials(b: Built, o: Object3D): { front: THREE.Material; side: THREE.Material; mats: THREE.Material[] } {
    const m = o.material;
    const mats: THREE.Material[] = [];
    let front: THREE.Material;
    let side: THREE.Material;
    if (m && (m.style === "photo" || (m.style === "image" && m.assetId)) && m.mapping === "camera" && m.style !== undefined) {
      // Pieces carry the picture they show at rest (where the camera sees each point of them at the
      // layer's start); anything else shows what the camera sees where it is now.
      const pieced = isPieced(o.geometry);
      const rest = pieced ? uniform(new THREE.Matrix4()) : null;
      const make = (sideOf: boolean) => {
        const base = { roughness: m.roughness, metalness: m.metalness, transparent: m.opacity < 1, opacity: m.opacity };
        const mat = m.metalness === 0 && m.opacity >= 1 ? new THREE.MeshPhysicalNodeMaterial({ ...base, specularIntensity: 0 }) : new THREE.MeshStandardNodeMaterial(base);
        const at = rest ? rest.mul(vec4(attribute("home", "vec3"), 1)) : vec4(positionWorld, 1);
        const clip = b.projector.mul(at);
        const ndc = clip.xy.div(clip.w);
        const uvp = vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5));
        const inside = step(0, uvp.x).mul(step(uvp.x, 1)).mul(step(0, uvp.y)).mul(step(uvp.y, 1)).mul(step(0, clip.w));
        const tex = texture(placeholder(), uvp);
        const rgb = tex.rgb.mul(tex.a).mul(inside);
        mat.colorNode = vec4(rgb.mul(materialColor), 1);
        mat.emissiveNode = rgb.mul(materialEmissive);
        mat.userData.projTex = tex;
        // A model's surfaces (single planes, normals either way) take the picture on whichever side the camera sees.
        if (o.geometry?.kind === "model") mat.side = THREE.DoubleSide;
        if (rest) mat.userData.rest = rest;
        if (sideOf) mat.userData.sideOf = true;
        if (m.style === "photo") mat.userData.photo = true;
        else mat.userData.image = m.assetId;
        return mat;
      };
      const mat = make(false);
      if (!pieced) return { front: mat, side: mat, mats: [mat] };
      // A piece's broken edges read as the material in shade.
      const edge = make(true);
      return { front: mat, side: edge, mats: [mat, edge] };
    }
    if (m?.style === "shadow") {
      // A holdout is drawn opaque: it writes its shadow (or nothing) over what's behind it in this layer.
      front = side = new THREE.ShadowMaterial({ opacity: m.opacity, color: 0x000000, ...(m.holdout ? { transparent: false } : {}) });
      mats.push(front);
    } else {
      const base = { roughness: m?.roughness ?? 0.8, metalness: m?.metalness ?? 0, transparent: (m?.opacity ?? 1) < 1, opacity: m?.opacity ?? 1 };
      // A picture-faced surface that's solid and not metal is matte: a sheen would lift its dark parts
      // above the picture (glass keeps its sheen).
      const picture = m?.style === "photo" || (m?.style === "image" && !!m.assetId);
      const matte = picture && base.metalness === 0 && !base.transparent;
      const make = () => (matte ? new THREE.MeshPhysicalMaterial({ ...base, specularIntensity: 0 }) : new THREE.MeshStandardMaterial(base));
      front = make();
      // Pieces cut from areas carry the picture round their sides as well (like a layer mapped onto
      // shattered pieces); a box's sides stay plain.
      const mappedSides = isPieced(o.geometry);
      if (m?.style === "image" && m.assetId) {
        // A picture on the front (e.g. what's seen through an opening, or a cut-out character). Its
        // transparent parts are cut out, from the picture and from its shadow.
        front.userData.image = m.assetId;
        side = make();
        side.userData.sideOf = true;
        if (mappedSides) side.userData.image = m.assetId;
        for (const x of [front, side]) x.alphaTest = 0.5;
        // A standing picture casts its shadow whichever side the light is on.
        if (o.geometry?.kind === "plane") front.side = THREE.DoubleSide;
        mats.push(front, side);
      } else if (m?.style === "photo") {
        front.userData.photo = true;
        side = make();
        side.userData.sideOf = true;
        if (mappedSides) side.userData.photo = true;
        mats.push(front, side);
      } else {
        side = front;
        mats.push(front);
      }
    }
    return { front, side, mats };
  }

  /** Bring the three.js scene up to date with the data and set everything for this frame. */
  private update(src: Scene3DSource): { b: Built; pending: boolean } | null {
    const r = src.resolved;
    if (!r) return null;
    const b = this.buildScene(r.scene.id);
    // Its pictures (the building photo, pictures on surfaces) load before anything is made: a surface
    // first drawn without its picture and given it later kept drawing slightly differently for the
    // rest of the session from one made with it, so the first scene drawn in a session (its pictures
    // still loading) didn't match the same frame drawn any other time.
    let loading = r.photoAssetId ? this.photo(r.photoAssetId) === undefined : false;
    for (const ro of r.objects) {
      const m = ro.object.material;
      if (m?.style === "image" && m.assetId && this.photo(m.assetId) === undefined) loading = true;
    }
    if (loading) return { b, pending: true };
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
    // The scene's own camera this frame, and the projection pictures are projected through.
    b.cam = r.cameraAt(t);
    {
      const pc = new THREE.PerspectiveCamera();
      this.placeCamera(pc, r, b.cam);
      pc.updateMatrixWorld();
      b.projector.value.multiplyMatrices(pc.projectionMatrix, pc.matrixWorldInverse);
    }
    const physics = r.physics;
    const motion = physics && this.physics ? this.physics.motion(physics.key) : null;
    // The lights as they are now: a picture-faced surface is evened out by what falls on it facing the
    // audience, so at rest it shows its picture exactly.
    const lightsNow: LightNow[] = [];
    for (const ro of r.objects) {
      const o = ro.object;
      if (o.kind !== "light" || !o.light || !activeAt(o, t)) continue;
      const L = o.light;
      const c = srgb(L.color);
      const g = L.type === "ambient" ? srgb(L.color.map((x) => x * 0.3)) : null;
      lightsNow.push({ type: L.type, color: [c.r, c.g, c.b], ...(g ? { ground: [g.r, g.g, g.b] as const } : {}), intensity: evalProp(L.intensity, t), position: objectPose(r.scene, o, t).place([0, 0, 0]), target: L.target, angle: L.angle, softness: L.softness, ...(L.range ? { range: L.range } : {}), ...(L.falloff !== undefined ? { falloff: L.falloff } : {}), balance: balancesPicture(L) });
    }
    for (const ro of r.objects) {
      const e = b.entries.get(ro.object.id)!;
      const o = e.model;
      // Where it is: its own animation about its pivot, carried by whatever it rides on.
      const pose = objectPose(r.scene, o, t);
      const pos = pose.place([0, 0, 0]);
      const scl = pose.scale;
      const q = pose.q;
      if (e.light && o.light) {
        const L: Light3D = o.light;
        const k = evalProp(L.intensity, t);
        e.light.intensity = L.type === "spot" || L.type === "point" ? k * 50 : k;
        // A soft fill (hemisphere light) takes its "up" direction from its position: keep it straight up.
        if (L.type === "ambient") e.light.position.set(0, 1, 0);
        else e.light.position.set(pos[0], pos[1], pos[2]);
        e.light.visible = activeAt(o, t);
        if (e.light instanceof THREE.PointLight || e.light instanceof THREE.SpotLight) {
          // Range (a smooth fade to nothing there; 0: no limit) and falloff; its shadow reaches as far.
          e.light.distance = L.range && L.range > 0 ? L.range : 0;
          e.light.decay = L.falloff ?? 2;
          const sh = e.light.shadow;
          const far = L.range && L.range > 0 ? L.range : 60;
          if (sh && sh.camera.far !== far) {
            sh.camera.far = far;
            sh.camera.updateProjectionMatrix();
          }
        }
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
        m.visible = activeAt(o, t);
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
        continue;
      }
      // Materials.
      const m = o.material;
      const picture = m?.style === "photo" || m?.style === "image";
      // Evened out by the picture's own lighting only: added lights (lanterns, glows) brighten it and
      // cast shadows on top of the picture instead of being cancelled out.
      const gain = picture && m.opacity >= 1 ? pictureGain(frontIrradiance(lightsNow.filter((l) => l.balance), e.pieces[0] ? pose.place(e.pieces[0].center) : pos)) : null;
      for (const mat0 of e.mats) {
        // Standard and physical materials, classic or node-based (a picture projected through the camera).
        const flags = mat0 as { isMeshStandardMaterial?: boolean; isMeshStandardNodeMaterial?: boolean };
        if (m && (flags.isMeshStandardMaterial || flags.isMeshStandardNodeMaterial)) {
          const mat = mat0 as THREE.MeshStandardMaterial;
          const c = evalProp(m.color, t);
          const glow = evalProp(m.glow, t);
          mat.color.copy(srgb(c));
          mat.emissive.copy(srgb(c));
          if (mat.userData.photo || mat.userData.image) {
            // The picture: the part the lights shade (evened out, so at rest it shows exactly) and the
            // part shown as it is (what shading leaves, plus glow) — both carry the picture.
            const mix = pictureMix(m, glow, gain ?? [1, 1, 1]);
            mat.color.setRGB(mat.color.r * mix.lit[0], mat.color.g * mix.lit[1], mat.color.b * mix.lit[2]);
            mat.emissiveIntensity = mix.self;
            // The broken edges of pieces carrying a projected picture: that picture, in shade.
            if (mat.userData.sideOf && mat.userData.projTex) {
              mat.color.multiplyScalar(0.45);
              mat.emissiveIntensity *= 0.45;
            }
            const rest = mat.userData.rest as { value: THREE.Matrix4 } | undefined;
            if (rest) restMatrix(rest.value, r.scene, o);
          } else {
            // Plain sides read as the material in shade.
            if (mat.userData.sideOf) mat.color.multiplyScalar(picture ? 0.38 : 0.55);
            mat.emissiveIntensity = glow;
          }
          const showPicture = (img: THREE.Texture) => {
            if (mat.map === img) return;
            mat.map = img;
            mat.emissiveMap = img;
            mat.needsUpdate = true;
          };
          // Projected through the camera: the picture goes into its projection instead of the face's own coordinates.
          const proj = mat.userData.projTex as { value: THREE.Texture } | undefined;
          const put = proj ? (img: THREE.Texture) => void (proj.value !== img && (proj.value = img)) : showPicture;
          if (mat.userData.photo) {
            if (photo) put(photo);
            else if (photo === undefined && r.photoAssetId) pending = true;
          }
          if (mat.userData.image) {
            const img = this.photo(mat.userData.image as string);
            if (img) put(img);
            else if (img === undefined) pending = true;
          }
        }
      }
      if (e.model3d) {
        if ("pending" in e.model3d) {
          if (this.models.get(e.model3d.pending) === undefined) pending = true;
          continue;
        }
        // Placed by the object's transform (turning about its pivot), or by physics once it moves
        // under it; the file's own animation follows the layer's time.
        const { root, mixer } = e.model3d;
        root.visible = activeAt(o, t);
        root.scale.set(scl[0], scl[1], scl[2]);
        const fromMotion = ro.poseIndex >= 0 && !!physics && src.frame >= (ro.motionFrom ?? 0);
        if (fromMotion && !(motion && motion.ready > src.frame)) pending = true;
        if (fromMotion && motion && motion.ready > src.frame) {
          const off = (src.frame * physics!.movers + ro.poseIndex) * 7;
          const d = motion.data;
          root.position.set(d[off]!, d[off + 1]!, d[off + 2]!);
          root.quaternion.set(d[off + 3]!, d[off + 4]!, d[off + 5]!, d[off + 6]!);
        } else {
          const w = pose.place([0, 0, 0]);
          root.position.set(w[0], w[1], w[2]);
          root.quaternion.set(q[0], q[1], q[2], q[3]);
        }
        const clip = o.clip ?? { speed: 1, offset: 0 };
        mixer.setTime(Math.max(0, (t / FLICKS_PER_SECOND) * clip.speed + clip.offset));
        continue;
      }
      // Pieces: from prepared motion once they move, otherwise placed with the object.
      const moving = ro.poseIndex >= 0 && physics;
      const needMotion = moving && src.frame >= (ro.motionFrom ?? SceneHost.firstMoving(physics));
      const haveMotion = !!motion && motion.ready > src.frame;
      if (needMotion && !haveMotion) pending = true;
      const list = e.pieces.length ? e.pieces : [null];
      list.forEach((piece, i) => {
        const mesh = e.meshes[i];
        if (!mesh) return;
        mesh.visible = activeAt(o, t);
        mesh.scale.set(scl[0], scl[1], scl[2]);
        if (needMotion && haveMotion) {
          const off = (src.frame * physics.movers + ro.poseIndex + i) * 7;
          const d = motion.data;
          mesh.position.set(d[off]!, d[off + 1]!, d[off + 2]!);
          mesh.quaternion.set(d[off + 3]!, d[off + 4]!, d[off + 5]!, d[off + 6]!);
        } else if (o.blocks && piece && !moving) {
          // Blocks: each pushed out or turned about its own middle, worked out from time.
          const bp = blockPose(o.blocks, e.pieces, i, t / FLICKS_PER_SECOND);
          const w = pose.place([piece.center[0], piece.center[1], piece.center[2] + bp.dz]);
          mesh.position.set(w[0], w[1], w[2]);
          tmpQ.set(q[0], q[1], q[2], q[3]);
          if (bp.angle) tmpQ.multiply(blockQ.setFromAxisAngle(bp.axis === "x" ? X_AXIS : Y_AXIS, bp.angle));
          mesh.quaternion.copy(tmpQ);
        } else {
          const c = piece ? piece.center : ([0, 0, 0] as Vec3);
          const w = pose.place(c);
          mesh.position.set(w[0], w[1], w[2]);
          mesh.quaternion.set(q[0], q[1], q[2], q[3]);
        }
      });
    }
    return { b, pending };
  }

  /** What the 3D host holds on the graphics card: its render targets, built scenes and three.js's own count. */
  memoryReport(): { targets: number; targetBytes: number; builtScenes: number; sceneBytes: number; geometries: number; textures: number } {
    let targetBytes = 0;
    // Half-float colour with 4x multisampling, plus the resolved copy and depth.
    for (const rt of this.targets.values()) targetBytes += rt.width * rt.height * (8 * 4 + 8 + 4 * 4);
    const info = this.renderer.info.memory as { geometries?: number; textures?: number };
    return { targets: this.targets.size, targetBytes, builtScenes: this.built.size, sceneBytes: this.sceneBytes(), geometries: info.geometries ?? 0, textures: info.textures ?? 0 };
  }

  /**
   * What the built scenes hold on the graphics card, each geometry and picture counted once (scenes
   * can share them): vertex data, pictures on surfaces (with their smaller copies), shadow maps
   * (a point light's six). Estimated from their sizes.
   */
  private sceneBytes(): number {
    const seen = new Set<object>();
    let bytes = 0;
    const picture = (t: THREE.Texture) => {
      if (seen.has(t)) return;
      seen.add(t);
      const img = t.image as { width?: number; height?: number } | null;
      if (img?.width && img.height) bytes += img.width * img.height * 4 * (t.generateMipmaps ? 4 / 3 : 1);
    };
    for (const b of this.built.values())
      b.scene.traverse((o) => {
        const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        if (g && !seen.has(g)) {
          seen.add(g);
          for (const a of Object.values(g.attributes)) bytes += (a as THREE.BufferAttribute).array.byteLength;
          if (g.index) bytes += g.index.array.byteLength;
        }
        const mats = (o as THREE.Mesh).material;
        for (const m of mats ? [mats].flat() : []) for (const v of Object.values(m)) if ((v as THREE.Texture | null)?.isTexture) picture(v as THREE.Texture);
        const l = o as THREE.Light & { shadow?: THREE.LightShadow };
        if (l.isLight && l.castShadow && l.shadow?.map) bytes += l.shadow.mapSize.x * l.shadow.mapSize.y * 4 * ((l as THREE.PointLight).isPointLight ? 6 : 1);
      });
    return bytes;
  }

  /** Free render targets and built scenes nobody has drawn for a while (at most once a second). */
  private sweep(): void {
    const now = performance.now();
    if (now - this.lastSweep < 1000) return;
    this.lastSweep = now;
    for (const [key, used] of this.targetUsed) {
      if (now - used < 5000) continue;
      this.targets.get(key)?.dispose();
      this.targets.delete(key);
      this.targetUsed.delete(key);
    }
    for (const [id, used] of this.builtUsed) {
      if (now - used < 60_000) continue;
      const b = this.built.get(id);
      if (b) {
        for (const e of b.entries.values()) this.dropEntry(b, e);
        b.entries.clear();
        for (const h of b.helpers) b.scene.remove(h);
        if (b.backdrop) {
          b.backdrop.geometry.dispose();
          (b.backdrop.material as THREE.Material).dispose();
        }
        b.frustum?.geometry.dispose();
      }
      this.built.delete(id);
      this.builtUsed.delete(id);
    }
  }

  private target(key: string, w: number, h: number): THREE.RenderTarget {
    this.targetUsed.set(key, performance.now());
    this.sweep();
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
    // Every render is a frame of its own for three.js. It redraws shadow maps (and anything else it
    // updates once a frame) only when its frame count has moved on, and that count moves with the
    // screen's refresh: frames drawn within one refresh (preparing runs several) reused the first's
    // shadows — a light coming through an opening, or slats' edges, then depended on timing.
    (this.renderer as unknown as { _nodes: { nodeFrame: { update(): void } } })._nodes.nodeFrame.update();
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
    this.placeCamera(b.showCam, r, b.cam);
    // A composition sized differently from the building canvas frames its part of it (from its top
    // left, like the 2D layers), from the same viewpoint: nothing stretches, depth lines up.
    const v = src.view;
    if (v && (v.width !== r.canvas.width || v.height !== r.canvas.height)) b.showCam.setViewOffset(r.canvas.width, r.canvas.height, 0, 0, v.width, v.height);
    else b.showCam.clearViewOffset();
    b.showCam.updateProjectionMatrix();
    this.setInspectOnly(b, false);
    this.fitShadows(b, height);
    const texture = this.draw(`show:${r.scene.id}`, b.scene, b.showCam, width, height);
    return texture ? { texture, pending: u.pending } : null;
  }

  /**
   * Shadow maps sized for what's being drawn: the largest size asked for in the last second, so a
   * full-size preview and a smaller preparation drawing in turn don't resize the maps every frame.
   * (three.js resizes a light's shadow map when its mapSize changes.)
   */
  private fitShadows(b: Built, height: number): void {
    const now = performance.now();
    b.shadowAsks = b.shadowAsks.filter(([, at]) => now - at < 1000);
    b.shadowAsks.push([shadowMapSize(height), now]);
    const size = Math.max(...b.shadowAsks.map(([sz]) => sz));
    for (const e of b.entries.values()) {
      const sh = e.light?.castShadow ? (e.light as THREE.DirectionalLight).shadow : null;
      if (sh && sh.mapSize.x !== size) sh.mapSize.set(size, size);
    }
  }

  /**
   * Set a three.js camera to the scene's view: its own camera (Scene3D.camera) when it has one, with
   * the canvas filling its view, otherwise the show camera that lines the building front up with the
   * canvas. (Projection only; a composition sized differently is framed by the caller.)
   */
  private placeCamera(pc: THREE.PerspectiveCamera, r: NonNullable<Scene3DSource["resolved"]>, cam: CameraNow | null): void {
    pc.near = 0.05;
    pc.far = 500;
    pc.aspect = r.canvas.width / r.canvas.height;
    if (cam) {
      pc.fov = cam.fovY;
      pc.position.set(cam.eye[0], cam.eye[1], cam.eye[2]);
      pc.quaternion.set(cam.q[0], cam.q[1], cam.q[2], cam.q[3]);
    } else {
      const sc = showCamera(r.canvas, r.cameraDistance);
      pc.fov = sc.fovY;
      pc.aspect = sc.aspect;
      pc.position.set(sc.eye[0], sc.eye[1], sc.eye[2]);
      pc.lookAt(sc.target[0], sc.target[1], sc.target[2]);
    }
    pc.updateProjectionMatrix();
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
    // The view it's seen through (the show camera, or the scene's own) as lines.
    if (!b.frustum) {
      b.frustum = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffc46b, transparent: true, opacity: 0.6 }));
      b.scene.add(b.frustum);
    }
    let e: Vec3;
    let corners: Vec3[];
    if (b.cam) {
      const pc = new THREE.PerspectiveCamera();
      this.placeCamera(pc, r, b.cam);
      pc.updateMatrixWorld();
      e = b.cam.eye;
      const D = 12;
      const ty = Math.tan((b.cam.fovY * Math.PI) / 360) * D;
      const tx = ty * (r.canvas.width / r.canvas.height);
      corners = ([[-tx, -ty], [tx, -ty], [tx, ty], [-tx, ty]] as const).map(([x, y]) => {
        const v = new THREE.Vector3(x, y, -D).applyMatrix4(pc.matrixWorld);
        return [v.x, v.y, v.z] as Vec3;
      });
    } else {
      const cam = showCamera(r.canvas, r.cameraDistance);
      e = cam.eye;
      corners = [[-Wm / 2, 0, 0], [Wm / 2, 0, 0], [Wm / 2, Hm, 0], [-Wm / 2, Hm, 0]];
    }
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
  a.material?.mapping === b.material?.mapping &&
  a.material?.holdout === b.material?.holdout &&
  a.light?.type === b.light?.type &&
  a.light?.castShadow === b.light?.castShadow &&
  a.light?.angle === b.light?.angle &&
  a.light?.softness === b.light?.softness &&
  JSON.stringify(a.light?.color) === JSON.stringify(b.light?.color);
