/**
 * Inspector for a 3D layer: its objects, gravity, whether pieces stay inside the area, and the
 * selected object's position, look, physics, breaking apart and light. Values with ◆ can be
 * animated: click ◆ to add a keyframe at the playhead; once animated, changing the value sets a
 * keyframe at the playhead.
 */
import { type AnimProp, balancesPicture, type Blocks3D, DEFAULT_BLOCKS, DEFAULT_FRACTURE, evalProp, isPieced, PARTICLE_PRESETS, type Particles3D, type Fracture3D, keyAt, type Layer, type Light3D, type Material3D, type Object3D, type Physics3D, type PropValue, quatToEulerDeg, type RGBA, type Scene3D, type SceneCamera, sceneCameraAt, timeToSeconds, type Vec2, type Vec3 } from "@be/core";
import { type ReactNode, useEffect, useState } from "react";
import { addAreaObject, addModelFromFile, addModelObject, addPictureFromFile, addObject, ensureModelInfo, layerTime, removeObject, sceneArea, setContain, setPropNow, toggleKeyNow, updateObject, use3D } from "./actions3d.ts";
import { getRenderer } from "./engineHost.ts";
import { Choice, ColorField, Field, Slider, Toggle } from "./controls.tsx";
import { PartEditor } from "./PartEditor.tsx";
import { EditableSection, JobProgressFor } from "./BlenderPanel.tsx";
import { linkForScene, openInBlender, useBlenderJobs } from "./blenderEffects.ts";
import { AreaPicker } from "./AreaPicker.tsx";
import { LayerIdentity, LayerMasks, LayerTiming } from "./LayerPanel.tsx";
import { simProgress, useSims } from "./simHost.ts";
import { activeVenue, currentComp, useStudio } from "./store.ts";

const KeyButton = ({ layer, prop, onChange, label }: { layer: Layer; prop: AnimProp; onChange: (p: AnimProp) => void; label: string }) => {
  const time = useStudio((s) => s.time);
  const on = !!keyAt(prop, layerTime(layer, time));
  const animated = (prop.keyframes?.length ?? 0) > 0;
  return (
    <button
      className={`key-btn ${on ? "on" : animated ? "animated" : ""}`}
      aria-pressed={on}
      aria-label={on ? `Remove the ${label} keyframe at the playhead` : `Add a ${label} keyframe at the playhead`}
      title={on ? "Remove the keyframe here" : animated ? "Add a keyframe here (this value is animated)" : "Animate: add a keyframe at the playhead"}
      onClick={() => onChange(toggleKeyNow(layer, prop))}
    >
      ◆
    </button>
  );
};

const Section = ({ title, children, open: initial = false }: { title: string; children: ReactNode; open?: boolean }) => {
  const [open, setOpen] = useState(initial);
  return (
    <section className="param-group">
      <button className="disclosure" aria-expanded={open} onClick={() => setOpen(!open)}>
        {title}
      </button>
      {open && children}
    </section>
  );
};

const PhysicsStatus = ({ layerId }: { layerId: string }) => {
  const status = useSims((s) => s.status);
  const p = simProgress(status, [layerId]);
  if (!p) return null;
  if (p.done >= p.total) return <p className="ok-text small physics-status">✓ Physics prepared ({p.total} frames). Changing how things fall prepares it again.</p>;
  return (
    <div className="sim-status physics-status">
      <span className="small">Preparing the physics… {Math.round((p.done / Math.max(1, p.total)) * 100)}%</span>
      <progress max={p.total} value={p.done} aria-label="Physics preparation progress" />
    </div>
  );
};

/**
 * Where the audience stands (the show camera), in building widths in front of the building. Scenes
 * following the building's viewpoint share one, so depth illusions line up across the show.
 */
const ViewpointField = ({ scene, onScene }: { scene: Scene3D; onScene: (v: number | null, label: string) => void }) => {
  const venue = useStudio((st) => activeVenue(st));
  const shared = venue?.cameraDistance ?? 1.6;
  const follows = scene.cameraDistance === undefined;
  const setShared = (v: number) => venue && useStudio.getState().apply({ type: "venue.update", args: { venueId: venue.id, changes: { cameraDistance: v } } }, { label: "Change the audience viewpoint", coalesceKey: "venue:viewpoint" });
  return (
    <Field label="Audience viewpoint" help="How far in front of the building the audience (the show camera) stands, in building widths. It sets the perspective of everything that stands out of, or moves away from, the wall. Scenes that use the building's viewpoint all share one, so their depth lines up.">
      <Toggle label="Same as the building's (every scene)" value={follows} onChange={(v) => onScene(v ? null : shared, v ? "Use the building's viewpoint" : "Give this scene its own viewpoint")} />
      <Slider label="Audience distance" value={scene.cameraDistance ?? shared} min={0.2} max={20} step={0.05} onChange={(v) => (follows ? setShared(v) : onScene(v, "Change this scene's viewpoint"))} />
      {follows && <p className="muted small">Changing it changes every scene that uses the building's viewpoint.</p>}
    </Field>
  );
};

/**
 * What the scene is seen through: the show camera (straight on, lining the building front up with the
 * canvas), a camera in one of its models (the Blender scene's camera, placed with that model), or
 * one set by hand. Pictures projected through the camera stay put while you orbit to inspect.
 */
const CameraField = ({ scene, layer }: { scene: Scene3D; layer: Layer }) => {
  const project = useStudio((s) => s.project)!;
  const time = useStudio((s) => s.time);
  const set = (camera: SceneCamera | null, label: string, key = "camera") =>
    useStudio.getState().apply({ type: "scene3d.update", args: { sceneId: scene.id, changes: { camera } } }, { label, coalesceKey: `${scene.id}:${key}` });
  const fromModels = scene.objectOrder.flatMap((id) => {
    const o = scene.objects[id]!;
    if (o.geometry?.kind !== "model") return [];
    return (project.assets[o.geometry.assetId]?.meta.model?.cameras ?? []).map((c) => ({ value: `model|${o.id}|${c.name}`, label: `${o.name}: ${c.name}`, objectId: o.id, name: c.name }));
  });
  const c = scene.camera;
  const value = !c ? "show" : c.kind === "manual" ? "manual" : (fromModels.find((x) => x.objectId === c.objectId && (!c.name || x.name === c.name))?.value ?? "show");
  const choose = (v: string) => {
    if (v === "show") return set(null, "See the scene through the show camera");
    if (v === "manual") {
      // Starts where the camera is now.
      const now = sceneCameraAt(project, scene, layerTime(layer, time));
      return set({ kind: "manual", position: now?.eye ?? [0, 1.6, 8], rotation: now ? quatToEulerDeg(now.q) : [0, 0, 0], fovY: now?.fovY ?? 45 }, "Set the scene's camera by hand");
    }
    const m = fromModels.find((x) => x.value === v);
    if (m) set({ kind: "model", objectId: m.objectId, name: m.name }, `See the scene through ${m.label}`);
  };
  return (
    <Field label="Seen through" help="The show camera lines the building front up with the canvas. A model's camera (e.g. the Blender scene's) sees the scene exactly as that camera did, so a house model under its photo's camera shows the photo where it belongs, and Blender renders line up with it.">
      <select className="select" aria-label="Seen through" value={value} onChange={(e) => choose(e.target.value)}>
        <option value="show">The show camera (straight on)</option>
        {fromModels.map((x) => (
          <option key={x.value} value={x.value}>
            {x.label}
          </option>
        ))}
        <option value="manual">A camera set by hand</option>
      </select>
      {c?.kind === "manual" && (
        <>
          <Vec3Sliders label="Camera position" value={c.position} min={[-30, -5, -30]} max={[30, 30, 60]} step={0.01} unit="m" onChange={(v) => set({ ...c, position: v }, "Move the scene's camera", "camera-pos")} />
          <Vec3Sliders label="Camera turn" value={c.rotation} min={[-180, -180, -180]} max={[180, 180, 180]} step={0.1} unit="°" onChange={(v) => set({ ...c, rotation: v }, "Turn the scene's camera", "camera-rot")} />
          <Field label="Field of view (vertical)">
            <Slider label="Field of view" value={c.fovY} min={5} max={120} step={0.01} unit="°" onChange={(v) => set({ ...c, fovY: v }, "Change the camera's field of view", "camera-fov")} />
          </Field>
        </>
      )}
    </Field>
  );
};

/** When an object is there (seconds into the layer, like a layer's in and out points): drawn, casting shadows, lighting and colliding only then. */
const ActiveField = ({ o, lenS, up }: { o: Object3D; lenS: number; up: (changes: Partial<Record<keyof Object3D, unknown>>, label: string, key: string) => void }) => (
  <Field label="There" help="Seconds into this layer when it appears and goes. Outside them it isn't drawn, casts no shadow, gives no light and nothing hits it.">
    <div className="row gap">
      <Toggle label="From" value={o.activeFrom !== undefined} onChange={(v) => up({ activeFrom: v ? 0 : null }, v ? "Appear later" : "There from the start", "active-from-on")} />
      {o.activeFrom !== undefined && <Slider label="There from (seconds)" value={o.activeFrom} min={0} max={Math.max(1, lenS)} step={1 / 30} unit="s" onChange={(v) => up({ activeFrom: v }, "Change when it appears", "active-from")} />}
    </div>
    <div className="row gap">
      <Toggle label="Until" value={o.activeTo !== undefined} onChange={(v) => up({ activeTo: v ? Math.max(o.activeFrom ?? 0, lenS) : null }, v ? "Go before the end" : "There to the end", "active-to-on")} />
      {o.activeTo !== undefined && <Slider label="There until (seconds)" value={o.activeTo} min={o.activeFrom ?? 0} max={Math.max(1, lenS)} step={1 / 30} unit="s" onChange={(v) => up({ activeTo: v }, "Change when it goes", "active-to")} />}
    </div>
  </Field>
);

/** A model's parts (its top-level pieces, as named in Blender): show all, or only some (one file, several objects). */
const PartsField = ({ o, up }: { o: Object3D; up: (changes: Partial<Record<keyof Object3D, unknown>>, label: string, key: string) => void }) => {
  const g = o.geometry;
  const nodes = useStudio((s) => (g?.kind === "model" ? s.project?.assets[g.assetId]?.meta.model?.nodes : undefined));
  if (g?.kind !== "model" || !nodes || nodes.length < 2) return null;
  const on = g.nodes ?? nodes;
  const put = (next: string[]) => {
    const { nodes: _n, ...rest } = g;
    up({ geometry: next.length === nodes.length ? rest : { ...rest, nodes: next } }, "Change the model's parts", "nodes");
  };
  return (
    <Field label="Parts shown" help="The model's parts as named in its file. Show only some to make several objects from one file (a wall, and a door that comes and goes).">
      <div className="col">
        {nodes.map((n) => (
          <Toggle key={n} label={n} value={on.includes(n)} onChange={(v) => put(v ? [...on, n] : on.filter((x) => x !== n))} />
        ))}
      </div>
    </Field>
  );
};

/** A model's parts and a panel's outline as sizes, for the inspector. */
const panelSize = (outline: readonly Vec2[]): [number, number, number, number] => {
  const xs = outline.map((p) => p[0]), ys = outline.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
};

/** A model's size as measured, and why it isn't showing when its file couldn't be read. */
const ModelStatus = ({ assetId }: { assetId: string }) => {
  const asset = useStudio((st) => st.project?.assets[assetId]);
  const [problem, setProblem] = useState<string | null>(null);
  // Measured when it arrived; older ones (e.g. from Blender before measuring existed) are measured now.
  useEffect(() => {
    if (asset?.kind === "model" && !asset.meta.model?.nodes) void ensureModelInfo(assetId);
  }, [assetId, !!asset?.meta.model?.nodes]);
  useEffect(() => {
    let live = true;
    const look = () => void getRenderer().then((r) => live && setProblem(r.scenes.modelErrors.get(assetId) ?? null));
    look();
    const t = setInterval(look, 1500);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [assetId]);
  const b = asset?.meta.model?.bounds;
  return (
    <>
      {problem && (
        <p className="warn small" role="alert">
          “{asset?.name}” can't be shown: {problem}.
        </p>
      )}
      {b && (
        <p className="muted small">
          As made: {(b[3] - b[0]).toFixed(2)} × {(b[4] - b[1]).toFixed(2)} × {(b[5] - b[2]).toFixed(2)} m (wide × tall × deep){asset?.meta.model?.animations ? ` · ${asset.meta.model.animations} animation${asset.meta.model.animations > 1 ? "s" : ""}` : ""}
        </p>
      )}
    </>
  );
};

export const Scene3DPanel = ({ layer }: { layer: Layer }) => {
  const project = useStudio((s) => s.project)!;
  useStudio((s) => s.version);
  useStudio((s) => s.time);
  const picked = use3D((s) => s.objectId);
  const scene: Scene3D | undefined = layer.source.kind === "scene3d" ? project.scenes3d?.[layer.source.sceneId] : undefined;
  const [adding, setAdding] = useState(false);
  if (!scene) return <p className="muted small">This 3D layer's scene is missing.</p>;
  const o = scene.objects[picked ?? ""] ?? scene.objects[scene.objectOrder[0] ?? ""];
  // Gravity: strength and direction across the building, plus a pull toward (or away from) the audience.
  const g = Math.hypot(scene.gravity[0], scene.gravity[1]);
  const gz = scene.gravity[2];
  const gAngle = g > 0 ? Math.round((Math.atan2(scene.gravity[0], -scene.gravity[1]) * 180) / Math.PI) : 0;
  const setGravity = (strength: number, angle: number, toward = gz) => {
    const a = (angle * Math.PI) / 180;
    useStudio.getState().apply({ type: "scene3d.update", args: { sceneId: scene.id, changes: { gravity: [Math.sin(a) * strength, -Math.cos(a) * strength, toward] } } }, { label: "Change gravity", coalesceKey: `${scene.id}:gravity` });
  };
  const updateScene = (changes: { name?: string; cameraDistance?: number | null }, label: string, key: string) =>
    useStudio.getState().apply({ type: "scene3d.update", args: { sceneId: scene.id, changes } }, { label, coalesceKey: `${scene.id}:${key}` });
  const contained = layer.masks.some((m) => m.id === "contain");
  const area = sceneArea(scene);
  return (
    <div className="inspector-body scene3d-panel">
      <div className="panel-head">
        <h2>{scene.name}</h2>
      </div>
      <p className="muted small">{scene.camera ? "3D objects seen through the scene's own camera." : "3D objects in front of the building, seen through the show camera."} Orbit around them in “3D projection”.</p>
      <PhysicsStatus layerId={layer.id} />
      <FromBlender sceneId={scene.id} />
      <Section title="Layer">
        <Field label="3D scene name">
          <input className="text-input" value={scene.name} aria-label="3D scene name" onChange={(e) => e.target.value.trim() && updateScene({ name: e.target.value }, "Rename 3D scene", "name")} />
        </Field>
        <LayerIdentity layer={layer} />
        <LayerTiming layer={layer} />
        <LayerMasks layer={layer} />
        <CameraField scene={scene} layer={layer} />
        {!scene.camera && <ViewpointField scene={scene} onScene={(v, label) => updateScene({ cameraDistance: v }, label, "camera")} />}
      </Section>
      {area && (
        <Field
          label={scene.purpose === "parts" ? "Clipped to" : "Pieces and effects"}
          help={`${scene.purpose === "parts" ? "The parts are made from their own areas; this is the outline the whole layer is cut to." : "The solid is made from its area; this is whether what it shows is cut to that area."} Projector blackout areas (“Keep light off here”) apply either way.`}
        >
          <div className="segmented" role="radiogroup" aria-label="Clipped to">
            <button role="radio" aria-checked={contained} className={contained ? "on" : ""} onClick={() => setContain(layer, true)}>
              {scene.purpose === "parts" ? "The house outline" : "Contain within the area"}
            </button>
            <button role="radio" aria-checked={!contained} className={!contained ? "on" : ""} onClick={() => setContain(layer, false)}>
              {scene.purpose === "parts" ? "Nothing (can extend beyond)" : "Extend beyond"}
            </button>
          </div>
        </Field>
      )}

      <h3 className="subhead">Objects</h3>
      <div className="object-list" role="listbox" aria-label="3D objects">
        {scene.objectOrder.map((id) => {
          const x = scene.objects[id]!;
          return (
            <button key={id} role="option" aria-selected={o?.id === id} className={`list-item ${o?.id === id ? "on" : ""}`} onClick={() => use3D.setState({ objectId: id })}>
              <span aria-hidden="true">{x.kind === "light" ? "☀ " : x.kind === "particles" ? "✦ " : x.kind === "null" ? "✛ " : x.geometry?.kind === "model" ? "◆ " : x.fracture ? "▦ " : "■ "}</span>
              {x.name}
              {!x.visible && <span className="muted small"> · hidden</span>}
            </button>
          );
        })}
      </div>
      <span className="tool-pop">
        <button className="ghost" onClick={() => setAdding(!adding)} aria-expanded={adding}>
          + Add object
        </button>
        {adding && (
          <div className="popover" role="menu">
            {(
              [
                ["box", "Box (falls)"],
                ["ball", "Ball (falls and bounces)"],
                ["ledge", "Ledge (fixed, things land on it)"],
                ["light", "Spot light"],
                ["null", "Controller (a null others ride on)"],
                ["panel", "Panel (a flat solid: a door, a slab — it can break)"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                role="menuitem"
                className="list-item"
                onClick={() => {
                  setAdding(false);
                  addObject(layer, k);
                }}
              >
                {label}
              </button>
            ))}
            <div className="hint">A 3D model (characters, props): it shares this scene's depth, lights and shadows.</div>
            <button
              role="menuitem"
              className="list-item"
              onClick={() => {
                setAdding(false);
                void addModelFromFile(layer).catch((e) => useStudio.getState().toast({ kind: "error", text: String((e as Error)?.message ?? e) }));
              }}
            >
              From a file (.glb, .gltf)…
            </button>
            <button
              role="menuitem"
              className="list-item"
              onClick={() => {
                setAdding(false);
                void addPictureFromFile(layer);
              }}
            >
              A standing picture (a cut-out character, .png)…
            </button>
            {Object.values(project?.assets ?? {})
              .filter((a) => a.kind === "model")
              .map((a) => (
                <button
                  key={a.id}
                  role="menuitem"
                  className="list-item"
                  onClick={() => {
                    setAdding(false);
                    void addModelObject(layer, a.id);
                  }}
                >
                  {a.name}
                </button>
              ))}
            <div className="hint">A traced area as its own piece:</div>
            {Object.values(activeVenue(useStudio.getState())?.regions ?? {})
              .filter((r) => r.path.closed)
              .map((r) => (
                <button
                  key={r.id}
                  role="menuitem"
                  className="list-item"
                  onClick={() => {
                    setAdding(false);
                    addAreaObject(layer, r.id, r.name);
                  }}
                >
                  {r.name}
                </button>
              ))}
          </div>
        )}
      </span>

      <Section title="Gravity">
        <Field label="Strength" help="9.8 m/s² is Earth's gravity. 0 floats.">
          <Slider label="Gravity strength" value={Number(g.toFixed(2))} min={0} max={30} step={0.1} unit="m/s²" onChange={(v) => setGravity(v, gAngle)} />
        </Field>
        <Field label="Direction" help="0° pulls straight down; 90° pulls to the right.">
          <Slider label="Gravity direction" value={gAngle} min={-180} max={180} step={1} unit="°" onChange={(v) => setGravity(g, v)} />
        </Field>
        <Field label="Pull toward the audience" help="Positive pulls things out of the wall toward the audience; negative into the house.">
          <Slider label="Gravity toward the audience" value={Number(gz.toFixed(2))} min={-30} max={30} step={0.1} unit="m/s²" onChange={(v) => setGravity(g, gAngle, v)} />
        </Field>
      </Section>

      {o && <ObjectEditor key={o.id} layer={layer} scene={scene} o={o} />}
    </div>
  );
};

/** A 3D scene brought in from a .blend: open it in Blender, update after editing, and what came across. */
const FromBlender = ({ sceneId }: { sceneId: string }) => {
  useStudio((s) => s.version);
  const link = linkForScene(sceneId);
  const busy = useBlenderJobs((s) => !!link && !!s[link.id]?.running);
  if (!link) return null;
  return (
    <section className="param-group blender-link" aria-label="From Blender">
      <h3 className="subhead">
        From Blender <span className="badge">linked file</span>
      </h3>
      <div className="row gap wrap">
        <button className="ghost" disabled={busy} onClick={() => void openInBlender(link.id)}>
          Open in Blender
        </button>
      </div>
      <JobProgressFor linkId={link.id} />
      <EditableSection link={link} busy={busy} />
    </section>
  );
};

const Vec3Sliders = ({ label, value, min, max, step, unit, onChange }: { label: string; value: Vec3; min: Vec3; max: Vec3; step: number; unit: string; onChange: (v: Vec3) => void }) => (
  <>
    {(["X", "Y", "Z"] as const).map((axis, i) => (
      <Field key={axis} label={`${label} ${axis === "X" ? "(left/right)" : axis === "Y" ? "(up/down)" : "(toward the audience)"}`}>
        <Slider label={`${label} ${axis}`} value={Number(value[i]!.toFixed(2))} min={min[i]!} max={max[i]!} step={step} unit={unit} onChange={(v) => onChange(value.map((x, j) => (j === i ? v : x)) as unknown as Vec3)} />
      </Field>
    ))}
  </>
);

const ObjectEditor = ({ layer, scene, o }: { layer: Layer; scene: Scene3D; o: Object3D }) => {
  const project = useStudio((s) => s.project)!;
  const time = useStudio((s) => s.time);
  const venue = activeVenue({ project });
  const W = (venue?.canvas.width ?? 1920) * 0.01;
  const H = (venue?.canvas.height ?? 1080) * 0.01;
  const t = layerTime(layer, time);
  const up = (changes: Partial<Record<keyof Object3D, unknown>>, label: string, key: string) => updateObject(scene.id, o.id, changes, label, `${o.id}:${key}`);
  const anim = <V extends PropValue>(name: keyof Object3D, p: AnimProp<V>, v: V, label: string) => up({ [name]: setPropNow(layer, p, v) }, label, String(name));
  const cur = <V extends PropValue>(p: AnimProp<V>): V => {
    const k = (p.keyframes?.length ?? 0) > 0;
    return k ? evalProp(p, t) : p.value;
  };
  const pos = cur(o.position);
  const comp = currentComp(useStudio.getState());
  const lenS = comp ? timeToSeconds(layer.outPoint - layer.startTime) * layer.stretch : 10;
  const m = o.material;
  const ph = o.physics;
  const fr = o.fracture;
  const bl = o.blocks;
  const setBl = (c: Partial<Blocks3D>, label: string, key: string) => bl && up({ blocks: { ...bl, ...c } }, label, key);
  const L = o.light;
  const setMat = (c: Partial<Material3D>, label: string, key: string) => m && up({ material: { ...m, ...c } }, label, key);
  const setPhys = (c: Partial<Physics3D>, label: string, key: string) => ph && up({ physics: { ...ph, ...c } }, label, key);
  const setFr = (c: Partial<Fracture3D>, label: string, key: string) => fr && up({ fracture: { ...fr, ...c } }, label, key);
  const setLight = (c: Partial<Light3D>, label: string, key: string) => L && up({ light: { ...L, ...c } }, label, key);
  return (
    <div className="object-editor" aria-label={`Edit ${o.name}`}>
      <h3 className="subhead">{o.name}</h3>
      <div className="row gap">
        <input className="text-input grow" value={o.name} aria-label="Object name" onChange={(e) => up({ name: e.target.value || o.name }, "Rename 3D object", "name")} />
        <button className="ghost small-btn" onClick={() => up({ visible: !o.visible }, o.visible ? "Hide 3D object" : "Show 3D object", "visible")}>
          {o.visible ? "Hide" : "Show"}
        </button>
        <button className="ghost small-btn danger" onClick={() => removeObject(layer, o.id)}>
          Remove
        </button>
      </div>

      {o.part && <PartEditor o={o} />}
      {o.particles && (
        <>
          <Field label="Particles">
            <Choice
              label="Particles"
              value={o.particles.kind}
              choices={(Object.keys(PARTICLE_PRESETS) as Particles3D["kind"][]).map((k) => ({ value: k, label: PARTICLE_PRESETS[k].title.replace(" (3D)", "") }))}
              onChange={(v) => {
                const k = v as Particles3D["kind"];
                up({ particles: { ...PARTICLE_PRESETS[k].settings, from: o.particles!.from, seed: o.particles!.seed } }, `Change to ${PARTICLE_PRESETS[k].title.replace(" (3D)", "").toLowerCase()}`, "kind");
              }}
            />
          </Field>
          <Field label={o.particles.kind === "snow" ? "Falls over" : "Come from"} help={o.particles.kind === "snow" ? "No areas: over the whole picture." : undefined}>
            <AreaPicker
              value={o.particles.from?.regionIds ? [...o.particles.from.regionIds] : []}
              min={o.particles.kind === "snow" ? 0 : 1}
              onChange={(ids) => up({ particles: { ...o.particles!, from: ids.length ? { role: "areas", regionIds: ids } : null } }, "Change where particles come from", "from")}
            />
          </Field>
          <ParticlesEditor p={o.particles} lenS={lenS} set={(c, label, key) => up({ particles: { ...o.particles!, ...c } }, label, key)} />
        </>
      )}
      {!o.particles && (
        <>

      <Section title={L ? "Position" : "Position, turn and size"} open={!o.part}>
        <Field label="Rides on" help="Moves with another object (a pumpkin in a character's hands, a lantern carried along): its position, turn and size are then measured from that object.">
          <select
            value={o.attach?.to ?? ""}
            aria-label="Rides on"
            onChange={(e) => up({ attach: e.target.value ? { to: e.target.value, ...(o.attach?.until !== undefined && o.attach?.until !== null ? { until: o.attach.until } : {}) } : null }, e.target.value ? "Ride on another object" : "Stand on its own", "attach")}
          >
            <option value="">Nothing (stands on its own)</option>
            {scene.objectOrder
              .filter((id) => id !== o.id && scene.objects[id]?.attach?.to !== o.id)
              .map((id) => (
                <option key={id} value={id}>
                  {scene.objects[id]!.name}
                </option>
              ))}
          </select>
        </Field>
        {o.attach && (
          <Field label="Lets go at" help="Seconds into this layer when it stops riding: it stays where it was left, or (with physics) flies on with the speed it had.">
            <div className="row gap">
              <Toggle label="Lets go" value={o.attach.until !== undefined && o.attach.until !== null} onChange={(v) => up({ attach: { to: o.attach!.to, ...(v ? { until: Math.min(lenS, 1) } : {}) } }, v ? "Let go" : "Ride throughout", "attach-until-on")} />
              {o.attach.until !== undefined && o.attach.until !== null && (
                <Slider label="Lets go at (seconds)" value={o.attach.until} min={0} max={Math.max(1, lenS)} step={1 / 30} unit="s" onChange={(v) => up({ attach: { to: o.attach!.to, until: v }, ...(ph?.body === "dynamic" && ph.releaseAt !== undefined ? { physics: { ...ph, releaseAt: v } } : {}) }, "Change when it lets go", "attach-until")} />
              )}
            </div>
          </Field>
        )}
        <div className="row gap key-row">
          <span className="small muted grow">{(o.position.keyframes?.length ?? 0) > 0 ? `Animated (${o.position.keyframes!.length} keyframes)` : "Position"}</span>
          <KeyButton layer={layer} prop={o.position} label="position" onChange={(p) => up({ position: p }, "Animate position", "position-key")} />
        </div>
        <Vec3Sliders label={L ? "Light position" : "Position"} value={pos} min={[-W, -2, -10]} max={[W, H + 10, 20]} step={0.05} unit="m" onChange={(v) => anim("position", o.position, v, "Move 3D object")} />
        {!L && (
          <>
            <div className="row gap key-row">
              <span className="small muted grow">{(o.rotation.keyframes?.length ?? 0) > 0 ? `Turn animated (${o.rotation.keyframes!.length} keyframes)` : "Turn"}</span>
              <KeyButton layer={layer} prop={o.rotation} label="turn" onChange={(p) => up({ rotation: p }, "Animate turn", "rotation-key")} />
            </div>
            <Vec3Sliders label="Turn" value={cur(o.rotation)} min={[-180, -180, -180]} max={[180, 180, 180]} step={1} unit="°" onChange={(v) => anim("rotation", o.rotation, v, "Turn 3D object")} />
            <div className="row gap key-row">
              <span className="small muted grow">{(o.scale.keyframes?.length ?? 0) > 0 ? `Size animated (${o.scale.keyframes!.length} keyframes)` : "Size"}</span>
              <KeyButton layer={layer} prop={o.scale} label="size" onChange={(p) => up({ scale: p }, "Animate size", "scale-key")} />
            </div>
            <Field label="Size (all directions)">
              <Slider label="Size" value={cur(o.scale)[0]} min={10} max={400} step={1} unit="%" onChange={(v) => anim("scale", o.scale, [v, v, v] as Vec3, "Resize 3D object")} />
            </Field>
            <Vec3Sliders label="Size" value={cur(o.scale)} min={[1, 1, 1]} max={[400, 400, 400]} step={1} unit="%" onChange={(v) => anim("scale", o.scale, v, "Resize 3D object")} />
            <Vec3Sliders label="Turns about" value={o.pivot ?? [0, 0, 0]} min={[-W, -2, -10]} max={[W, H + 10, 20]} step={0.05} unit="m" onChange={(v) => up({ pivot: v }, "Move the turning point", "pivot")} />
            <Toggle label="Casts shadows" value={o.castShadow ?? true} onChange={(v) => up({ castShadow: v }, v ? "Cast shadows" : "No shadows", "cast")} />
            <Toggle label="Receives shadows" value={o.receiveShadow ?? true} onChange={(v) => up({ receiveShadow: v }, v ? "Receive shadows" : "No shadows on it", "receive")} />
          </>
        )}
        <ActiveField o={o} lenS={lenS} up={up} />
        {o.geometry?.kind === "model" && (
          <>
            <ModelStatus assetId={o.geometry.assetId} />
            <PartsField o={o} up={up} />
            <Toggle
              label="Covered with the building picture"
              value={!!m}
              onChange={(v) => up({ material: v ? { style: "photo", color: { value: [1, 1, 1, 1] }, roughness: 0.9, metalness: 0, glow: { value: 0 }, opacity: 1, mapping: "camera" } : null }, v ? "Cover the model with the picture" : "Use the model's own materials", "model-material")}
            />
            <p className="muted small">
              Its shapes, materials and animation come from its file
              {Object.values(project?.blenderLinks ?? {}).some((l) => l.editable?.assetId === (o.geometry?.kind === "model" ? o.geometry.assetId : ""))
                ? ": it came from Blender, so edit it there, then “Update the 3D from Blender” on its video layer"
                : ""}
              . Placement, timing, physics and lights here are kept.
            </p>
            <Field label="Animation speed" help="1 = as made in Blender; 0 holds it still.">
              <Slider label="Animation speed" value={o.clip?.speed ?? 1} min={0} max={4} step={0.05} onChange={(v) => up({ clip: { ...(o.clip ?? { speed: 1, offset: 0 }), speed: v } }, "Change animation speed", "clip-speed")} />
            </Field>
            <Field label="Animation starts from" help="Seconds into Blender's animation at the start of this layer.">
              <Slider label="Animation starts from" value={o.clip?.offset ?? 0} min={0} max={60} step={0.05} unit="s" onChange={(v) => up({ clip: { ...(o.clip ?? { speed: 1, offset: 0 }), offset: v } }, "Change animation start", "clip-offset")} />
            </Field>
          </>
        )}
        {o.geometry?.kind === "area" && !o.part && (
          <Field label="Made from" help="The areas this solid is made from.">
            <AreaPicker
              value={(() => {
                const ref = o.geometry.ref;
                return ref.regionIds ? [...ref.regionIds] : ref.groupId ? [...(activeVenue({ project })?.groups[ref.groupId]?.regionIds ?? [])] : [];
              })()}
              onChange={(ids) => o.geometry?.kind === "area" && up({ geometry: { ...o.geometry, ref: { role: "areas", regionIds: ids } } }, "Change the areas", "ref")}
            />
          </Field>
        )}
        {o.geometry?.kind === "plane" && (
          <>
            <Field label="Width">
              <Slider label="Plane width" value={o.geometry.size[0]} min={0.05} max={W * 2} step={0.05} unit="m" onChange={(v) => o.geometry?.kind === "plane" && up({ geometry: { kind: "plane", size: [v, o.geometry.size[1]] } }, "Change plane size", "plane")} />
            </Field>
            <Field label="Height">
              <Slider label="Plane height" value={o.geometry.size[1]} min={0.05} max={H * 2} step={0.05} unit="m" onChange={(v) => o.geometry?.kind === "plane" && up({ geometry: { kind: "plane", size: [o.geometry.size[0], v] } }, "Change plane size", "plane")} />
            </Field>
          </>
        )}
        {o.geometry?.kind === "area" && (
          <>
            <Field label="Thickness" help="How deep the solid is behind its front.">
              <Slider label="Thickness" value={Math.round(o.geometry.depth * 100)} min={2} max={200} step={1} unit="cm" onChange={(v) => up({ geometry: { ...o.geometry, depth: v / 100 } }, "Change thickness", "depth")} />
            </Field>
            <Field label="Stands out" help="How far its front stands out toward the audience (a column in front of a porch, a roof overhang). From the audience it stays on its picture; lights and shadows see the real solid.">
              <Slider label="Stands out" value={Math.round((o.geometry.standOut ?? 0) * 100)} min={0} max={500} step={1} unit="cm" onChange={(v) => up({ geometry: { ...o.geometry, standOut: v / 100 } }, "Change stand-out", "standout")} />
            </Field>
            <Field label="Cut out of it" help="Areas that are their own pieces in this scene: they're cut out of this one so the solids don't overlap.">
              <div className="col">
                {Object.values(activeVenue(useStudio.getState())?.regions ?? {})
                  .filter((r) => r.path.closed && !(o.geometry?.kind === "area" && o.geometry.ref.regionIds?.includes(r.id)))
                  .map((r) => {
                    const g = o.geometry as Extract<Object3D["geometry"], { kind: "area" }>;
                    const cut = g.cut?.regionIds ?? [];
                    return (
                      <Toggle
                        key={r.id}
                        label={r.name}
                        value={cut.includes(r.id)}
                        onChange={(v) => {
                          const next = v ? [...cut, r.id] : cut.filter((x) => x !== r.id);
                          const { cut: _old, ...rest } = g;
                          up({ geometry: next.length ? { ...rest, cut: { role: "areas", regionIds: next } } : rest }, v ? `Cut ${r.name} out` : `Don't cut ${r.name} out`, "cut");
                        }}
                      />
                    );
                  })}
              </div>
            </Field>
          </>
        )}
        {o.geometry?.kind === "panel" &&
          (() => {
            const g = o.geometry;
            const [x0, y0, w, h] = panelSize(g.outline);
            // Resized about its bottom-left corner.
            const resize = (nw: number, nh: number) => up({ geometry: { ...g, outline: g.outline.map((p) => [x0 + ((p[0] - x0) * nw) / (w || 1), y0 + ((p[1] - y0) * nh) / (h || 1)]), ...(g.holes ? { holes: g.holes.map((hl) => hl.map((p) => [x0 + ((p[0] - x0) * nw) / (w || 1), y0 + ((p[1] - y0) * nh) / (h || 1)])) } : {}) } }, "Resize panel", "panel-size");
            return (
              <>
                <p className="muted small">
                  A flat solid with {g.outline.length} corners{g.holes?.length ? ` and ${g.holes.length} opening${g.holes.length > 1 ? "s" : ""}` : ""}, its front at its position.
                </p>
                <Field label="Width">
                  <Slider label="Panel width" value={Number(w.toFixed(3))} min={0.05} max={Math.max(20, w * 2)} step={0.01} unit="m" onChange={(v) => resize(v, h)} />
                </Field>
                <Field label="Height">
                  <Slider label="Panel height" value={Number(h.toFixed(3))} min={0.05} max={Math.max(20, h * 2)} step={0.01} unit="m" onChange={(v) => resize(w, v)} />
                </Field>
                <Field label="Thickness" help="How deep the solid is behind its front.">
                  <Slider label="Thickness" value={Math.round(g.depth * 1000) / 10} min={0.5} max={100} step={0.5} unit="cm" onChange={(v) => up({ geometry: { ...g, depth: v / 100 } }, "Change thickness", "depth")} />
                </Field>
              </>
            );
          })()}
        {o.geometry?.kind === "box" && (
          <Vec3Sliders label="Box size" value={o.geometry.size} min={[0.05, 0.05, 0.05]} max={[W * 2, H * 2, 20]} step={0.05} unit="m" onChange={(v) => up({ geometry: { kind: "box", size: v } }, "Change box size", "box")} />
        )}
        {o.geometry?.kind === "sphere" && (
          <Field label="Radius">
            <Slider label="Radius" value={o.geometry.radius} min={0.05} max={5} step={0.05} unit="m" onChange={(v) => up({ geometry: { kind: "sphere", radius: v } }, "Change radius", "radius")} />
          </Field>
        )}
      </Section>

      {m && (
        <Section title="Look">
          <Field label="Surface">
            <Choice
              label="Surface"
              value={m.style}
              choices={[
                { value: "photo", label: "Building photo" },
                { value: "color", label: "Colour" },
                { value: "image", label: "A picture" },
                { value: "shadow", label: "Shadows only" },
              ]}
              onChange={(v) => setMat({ style: v as Material3D["style"] }, "Change surface", "style")}
            />
          </Field>
          {m.style === "image" && (
            <Field label="Picture" help="Shown on the front (and round the sides of pieces cut from areas, like the picture carried through the stone).">
              <select className="select" aria-label="Picture" value={m.assetId ?? ""} onChange={(e) => setMat({ assetId: e.target.value || undefined }, "Choose a picture", "asset")}>
                <option value="">Choose…</option>
                {Object.values(project.assets)
                  .filter((a) => a.kind === "image")
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          {m.style !== "shadow" && (
            <>
              <Field label={m.style === "photo" ? "Tint" : "Colour"}>
                <div className="row gap">
                  <ColorField label="Colour" value={cur(m.color) as unknown as number[]} onChange={(v) => setMat({ color: setPropNow(layer, m.color, v as unknown as RGBA) }, "Change colour", "color")} />
                  <KeyButton layer={layer} prop={m.color} label="colour" onChange={(p) => setMat({ color: p as AnimProp<RGBA> }, "Animate colour", "color-key")} />
                </div>
              </Field>
              <Field label="Glow">
                <div className="row gap">
                  <Slider label="Glow" value={cur(m.glow)} min={0} max={10} step={0.1} onChange={(v) => setMat({ glow: setPropNow(layer, m.glow, v) }, "Change glow", "glow")} />
                  <KeyButton layer={layer} prop={m.glow} label="glow" onChange={(p) => setMat({ glow: p as AnimProp<number> }, "Animate glow", "glow-key")} />
                </div>
              </Field>
              {(m.style === "photo" || m.style === "image") && (
                <>
                  <Field label="Picture placed" help="Lined up with the canvas on its front (traced areas, cut-outs), or projected through the scene's camera like a slide projector: every surface at any depth or angle shows what that camera sees there (a house model under its photo's camera). Pieces carry their part of it when they break.">
                    <Choice
                      label="Picture placed"
                      value={m.mapping ?? "front"}
                      choices={[
                        { value: "front", label: "On its front" },
                        { value: "camera", label: "Through the scene camera" },
                      ]}
                      onChange={(v) => setMat({ mapping: v as Material3D["mapping"] }, v === "camera" ? "Project the picture through the camera" : "Put the picture on its front", "mapping")}
                    />
                  </Field>
                  <Field label="Shading" help="How much the lights shade the picture as it turns or falls into shadow. 0 = the picture itself, like a layer mapped onto the pieces.">
                    <Slider label="Shading" value={Math.round((m.shading ?? 1) * 100)} min={0} max={100} step={1} unit="%" onChange={(v) => setMat({ shading: v / 100 }, "Change shading", "shading")} />
                  </Field>
                  <Field label="Exact picture at rest" help="Facing the audience it shows the picture exactly, whatever the lights. Off: the picture as the lights really fall on it (for a light's own pass added over the house).">
                    <Toggle label="Exact picture at rest" value={m.matchPicture ?? true} onChange={(v) => setMat({ matchPicture: v }, v ? "Exact picture at rest" : "Picture as the lights fall", "match")} />
                  </Field>
                </>
              )}
              <Field label="Roughness">
                <Slider label="Roughness" value={m.roughness} min={0} max={1} step={0.05} onChange={(v) => setMat({ roughness: v }, "Change roughness", "rough")} />
              </Field>
              <Field label="Metallic" help="0 = paint or stone; 1 = metal (reflects the lights' colour).">
                <Slider label="Metallic" value={m.metalness ?? 0} min={0} max={1} step={0.05} onChange={(v) => setMat({ metalness: v }, "Change metallic", "metal")} />
              </Field>
              <Field label="Solid" help="Lower lets you see through it.">
                <Slider label="Solid" value={Math.round((m.opacity ?? 1) * 100)} min={5} max={100} step={1} unit="%" onChange={(v) => setMat({ opacity: v / 100 }, "Change see-through", "opacity")} />
              </Field>
            </>
          )}
          {m.style === "shadow" && (
            <>
              <Field label="Shadow darkness">
                <Slider label="Shadow darkness" value={m.opacity} min={0} max={1} step={0.05} onChange={(v) => setMat({ opacity: v }, "Change shadow darkness", "opacity")} />
              </Field>
              <Field label="Hides what's behind it" help="Things of this layer behind it are hidden, so the layers below show there: a wall standing in for the house picture, that debris can fall behind.">
                <Toggle label="Hides what's behind it" value={!!m.holdout} onChange={(v) => setMat({ holdout: v }, v ? "Hide what's behind it" : "Don't hide what's behind it", "holdout")} />
              </Field>
            </>
          )}
        </Section>
      )}

      {o.kind === "mesh" && (
        <Section title="Physics" open={!!fr}>
          <Field label="Moves">
            <Choice
              label="Moves"
              value={ph ? ph.body : "none"}
              choices={[
                { value: "none", label: "No physics" },
                { value: "static", label: "Fixed (others hit it)" },
                { value: "dynamic", label: "Falls and collides" },
              ]}
              onChange={(v) => up({ physics: v === "none" ? null : { ...(ph ?? { mass: 50, friction: 0.7, bounce: 0.2 }), body: v as Physics3D["body"] } }, "Change physics", "body")}
            />
          </Field>
          {ph && (
            <>
              <Field label="Mass" help="Heavier things push lighter ones aside. Mass alone doesn't change how fast something falls.">
                <Slider label="Mass" value={ph.mass} min={1} max={10000} step={1} unit="kg" onChange={(v) => setPhys({ mass: v }, "Change mass", "mass")} />
              </Field>
              <Field label="Friction" help="0 slides like ice; 1 grips.">
                <Slider label="Friction" value={ph.friction} min={0} max={2} step={0.05} onChange={(v) => setPhys({ friction: v }, "Change friction", "friction")} />
              </Field>
              <Field label="Bounce" help="0 lands dead; 1 bounces back fully.">
                <Slider label="Bounce" value={ph.bounce} min={0} max={1} step={0.05} onChange={(v) => setPhys({ bounce: v }, "Change bounce", "bounce")} />
              </Field>
              {ph.body === "dynamic" && (
                <Field label="Physics takes over" help="From the start, or later: until then it follows its animation (and what it rides on), then flies on with the speed and spin it had — a thrown pumpkin keeps going.">
                  <div className="row gap">
                    <Toggle label="Later" value={ph.releaseAt !== undefined} onChange={(v) => up({ physics: v ? { ...ph, releaseAt: o.attach?.until ?? Math.min(lenS, 1) } : (({ releaseAt: _r, ...rest }) => rest)(ph) }, v ? "Let go later" : "Physics from the start", "release-on")} />
                    {ph.releaseAt !== undefined && <Slider label="Physics takes over at (seconds)" value={ph.releaseAt} min={0} max={Math.max(1, lenS)} step={1 / 30} unit="s" onChange={(v) => setPhys({ releaseAt: v }, "Change when physics takes over", "release")} />}
                  </div>
                </Field>
              )}
            </>
          )}
        </Section>
      )}

      {isPieced(o.geometry) && (
        <Section title="Breaking apart" open={!!fr}>
          <Toggle
            label="Collapse and rebuild"
            value={!!fr}
            onChange={(v) => up(v ? { fracture: { ...DEFAULT_FRACTURE, collapseAt: Math.min(1, lenS / 4) }, physics: { ...(ph ?? { mass: 2000, friction: 0.7, bounce: 0.15 }), body: "dynamic" } } : { fracture: null }, v ? "Make it collapse" : "Stop it collapsing", "fracture")}
          />
          {fr && (
            <>
              <Field label="Breaks like" help="Glass: shards radiating from where it's struck (for a clear, thin pane also lower its strength and thickness above). Bricks: courses of heavy blocks, like a masonry wall; piece size is a block's length.">
                <div className="segmented" role="radiogroup" aria-label="Breaks like">
                  {(["pieces", "glass", "bricks"] as const).map((k) => (
                    <button key={k} role="radio" aria-checked={(fr.pattern ?? "pieces") === k} className={(fr.pattern ?? "pieces") === k ? "on" : ""} onClick={() => setFr({ pattern: k }, k === "glass" ? "Break like glass" : k === "bricks" ? "Break into bricks" : "Break into pieces", "pattern")}>
                      {k === "glass" ? "Glass shards" : k === "bricks" ? "Bricks" : "Pieces"}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Breaks" help="At a set time, or where something hits it: it stays whole until something moving hits it fast enough, then only the pieces around the hit break out, the way the hit was going (a pumpkin through a wall breaks it inward).">
                <div className="segmented" role="radiogroup" aria-label="Breaks">
                  {(["time", "impact"] as const).map((k) => (
                    <button key={k} role="radio" aria-checked={(fr.trigger ?? "time") === k} className={(fr.trigger ?? "time") === k ? "on" : ""} onClick={() => setFr(k === "impact" ? { trigger: k, rebuildAt: null } : { trigger: k }, k === "impact" ? "Break where hit" : "Break at a set time", "trigger")}>
                      {k === "impact" ? "Where something hits it" : "At a set time"}
                    </button>
                  ))}
                </div>
              </Field>
              {fr.trigger === "impact" && (
                <>
                  <Field label="Breaks out around the hit" help="How far around the hit the pieces let go.">
                    <Slider label="Impact radius" value={fr.impactRadius ?? 0.8} min={0.1} max={5} step={0.05} unit="m" onChange={(v) => setFr({ impactRadius: v }, "Change impact size", "impact-radius")} />
                  </Field>
                  <Field label="Hardest it takes" help="Hits slower than this (metres a second) don't break it.">
                    <Slider label="Impact speed" value={fr.impactSpeed ?? 3} min={0} max={30} step={0.5} unit="m/s" onChange={(v) => setFr({ impactSpeed: v }, "Change impact strength", "impact-speed")} />
                  </Field>
                </>
              )}
              <Field label="Piece size" help="Smaller pieces: more of them (up to 600).">
                <Slider label="Piece size" value={fr.pieceSize} min={15} max={300} step={1} unit="cm" onChange={(v) => setFr({ pieceSize: v }, "Change piece size", "size")} />
              </Field>
              <Field label="Collapses at" help="Seconds into this layer. Also draggable on the timeline.">
                <Slider label="Collapse at (seconds)" value={fr.collapseAt} min={0} max={Math.max(1, lenS)} step={1 / 30} unit="s" onChange={(v) => setFr({ collapseAt: v, ...(fr.rebuildAt !== null && fr.rebuildAt <= v ? { rebuildAt: Math.min(lenS, v + 1) } : {}) }, "Change collapse time", "collapse")} />
              </Field>
              <Toggle label="Rebuild afterwards" value={fr.rebuildAt !== null} onChange={(v) => setFr({ rebuildAt: v ? Math.min(lenS, fr.collapseAt + 3) : null }, v ? "Rebuild afterwards" : "Stay collapsed", "rebuild-on")} />
              {fr.rebuildAt !== null && (
                <>
                  <Field label="Rebuilds at">
                    <Slider label="Rebuild at (seconds)" value={fr.rebuildAt} min={fr.collapseAt + 0.1} max={Math.max(fr.collapseAt + 0.2, lenS)} step={1 / 30} unit="s" onChange={(v) => setFr({ rebuildAt: v }, "Change rebuild time", "rebuild")} />
                  </Field>
                  <Field label="Rebuild takes">
                    <Slider label="Rebuild duration" value={fr.rebuildSeconds} min={0.2} max={10} step={0.1} unit="s" onChange={(v) => setFr({ rebuildSeconds: v }, "Change rebuild duration", "rebuild-len")} />
                  </Field>
                </>
              )}
              <Field label="Lets go over" help="0: all at once. Longer: the top gives way first and the rest follows down the wall (crumbling).">
                <Slider label="Lets go over" value={fr.stagger ?? 0} min={0} max={5} step={0.1} unit="s" onChange={(v) => setFr({ stagger: v }, "Change how it lets go", "stagger")} />
              </Field>
              <Field label="Push toward the audience" help="Below 0 pushes the pieces into the building (a window broken inwards).">
                <Slider label="Push" value={fr.push} min={-8} max={8} step={0.1} unit="m/s" onChange={(v) => setFr({ push: v }, "Change push", "push")} />
              </Field>
              <Field label="Tumble">
                <Slider label="Tumble" value={fr.spin} min={0} max={3} step={0.05} unit="turns/s" onChange={(v) => setFr({ spin: v }, "Change tumble", "spin")} />
              </Field>
              <button className="ghost" onClick={() => setFr({ seed: fr.seed + 1 }, "Shuffle the pieces", "seed")}>
                Shuffle the pieces
              </button>
            </>
          )}
        </Section>
      )}

      {isPieced(o.geometry) && !fr && (
        <Section title="Blocks" open={!!bl}>
          <Toggle
            label="Move as blocks"
            value={!!bl}
            onChange={(v) => up(v ? { blocks: { ...DEFAULT_BLOCKS, stopAt: Math.max(1.5, lenS - 0.5) } } : { blocks: null }, v ? "Move as blocks" : "Stop moving as blocks", "blocks")}
          />
          {bl && (
            <>
              <Field label="Shape" help="Cubes: a grid. Columns: tall strips. Rows: wide strips.">
                <Choice label="Shape" value={bl.shape} choices={[{ value: "cubes", label: "Cubes" }, { value: "columns", label: "Columns" }, { value: "rows", label: "Rows" }]} onChange={(v) => setBl({ shape: v as Blocks3D["shape"] }, "Change the block shape", "shape")} />
              </Field>
              <Field label={bl.height !== undefined ? "Width" : "Size"} help="Smaller blocks: more of them (up to 600).">
                <Slider label="Block size" value={bl.size} min={10} max={300} step={1} unit="cm" onChange={(v) => setBl({ size: v }, "Change block size", "size")} />
              </Field>
              <Field label="Height" help="Shape the blocks like the stones or bricks they cover. 0: square blocks that fit the area.">
                <Slider label="Block height" value={bl.height ?? 0} min={0} max={300} step={1} unit="cm" onChange={(v) => setBl(v > 0 ? { height: v } : { height: undefined }, "Change block height", "height")} />
              </Field>
              <Field label="Brick bond" help="Every other row shifted along, like brickwork (50%: half a brick).">
                <Slider label="Brick bond" value={Math.round((bl.bond ?? 0) * 100)} min={0} max={100} step={1} unit="%" onChange={(v) => setBl({ bond: v / 100 }, "Change brick bond", "bond")} />
              </Field>
              <Field label="Line up" help="Slide the grid across and down so the blocks sit on the joints in the picture.">
                <div className="row gap">
                  <Slider label="Line up across" value={Math.round(bl.offset?.[0] ?? 0) % Math.max(1, Math.round(bl.size))} min={0} max={Math.round(bl.size)} step={1} unit="cm" onChange={(v) => setBl({ offset: [v, bl.offset?.[1] ?? 0] }, "Line up blocks", "offset")} />
                  <Slider label="Line up down" value={Math.round(bl.offset?.[1] ?? 0) % Math.max(1, Math.round(bl.height ?? bl.size))} min={0} max={Math.round(bl.height ?? bl.size)} step={1} unit="cm" onChange={(v) => setBl({ offset: [bl.offset?.[0] ?? 0, v] }, "Line up blocks", "offset")} />
                </div>
              </Field>
              <Field label="Gap" help="Space between the blocks, where the dark inside shows.">
                <Slider label="Gap between blocks" value={bl.gap} min={0} max={30} step={0.5} unit="cm" onChange={(v) => setBl({ gap: v }, "Change the gap", "gap")} />
              </Field>
              <Field label="Motion">
                <Choice label="Motion" value={bl.motion} choices={[{ value: "push", label: "Push out" }, { value: "turn", label: "Turn (slats)" }]} onChange={(v) => setBl({ motion: v as Blocks3D["motion"], amount: v === "turn" ? 75 : 40 }, "Change how blocks move", "motion")} />
              </Field>
              <Field label="Pattern" help="Pulse: all together. Ripple: rings from a point. Wave: a band across. Random: each its own. Checker: neighbours opposite.">
                <Choice
                  label="Pattern"
                  value={bl.pattern}
                  choices={[{ value: "pulse", label: "Pulse" }, { value: "ripple", label: "Ripple" }, { value: "wave", label: "Wave" }, { value: "random", label: "Random" }, { value: "checker", label: "Checker" }]}
                  onChange={(v) => setBl({ pattern: v as Blocks3D["pattern"] }, "Change the pattern", "pattern")}
                />
              </Field>
              <Field label={bl.motion === "turn" ? "Turns up to" : "Pushes out up to"}>
                <Slider label={bl.motion === "turn" ? "Turn angle" : "Push distance"} value={bl.amount} min={0} max={bl.motion === "turn" ? 180 : 200} step={1} unit={bl.motion === "turn" ? "°" : "cm"} onChange={(v) => setBl({ amount: v }, "Change how far blocks move", "amount")} />
              </Field>
              <Toggle label={bl.motion === "turn" ? "Turn both ways" : "Also sink into the wall"} value={bl.bothWays} onChange={(v) => setBl({ bothWays: v }, v ? "Move both ways" : "Move out only", "both")} />
              <Field label="Speed">
                <Slider label="Speed" value={bl.speed} min={0.05} max={4} step={0.05} unit="per s" onChange={(v) => setBl({ speed: v }, "Change speed", "speed")} />
              </Field>
              {(bl.pattern === "ripple" || bl.pattern === "wave") && (
                <Field label="Wavelength" help="Distance between crests.">
                  <Slider label="Wavelength" value={bl.wavelength} min={40} max={2000} step={10} unit="cm" onChange={(v) => setBl({ wavelength: v }, "Change wavelength", "wavelength")} />
                </Field>
              )}
              {bl.pattern === "wave" && (
                <Field label="Direction" help="0°: left to right · 90°: upward · 180°: right to left · 270°: downward.">
                  <Slider label="Wave direction" value={bl.direction} min={0} max={359} step={1} unit="°" onChange={(v) => setBl({ direction: v }, "Change wave direction", "direction")} />
                </Field>
              )}
              {bl.pattern === "ripple" && (
                <>
                  <Field label="Ripples start from (across)">
                    <Slider label="Ripple centre across" value={Math.round(bl.origin[0] * 100)} min={0} max={100} step={1} unit="%" onChange={(v) => setBl({ origin: [v / 100, bl.origin[1]] }, "Move the ripple centre", "origin-x")} />
                  </Field>
                  <Field label="Ripples start from (down)">
                    <Slider label="Ripple centre down" value={Math.round(bl.origin[1] * 100)} min={0} max={100} step={1} unit="%" onChange={(v) => setBl({ origin: [bl.origin[0], v / 100] }, "Move the ripple centre", "origin-y")} />
                  </Field>
                </>
              )}
              <Field label="Starts moving at" help="Seconds into this layer.">
                <Slider label="Blocks start at" value={bl.startAt} min={0} max={Math.max(1, lenS)} step={1 / 30} unit="s" onChange={(v) => setBl({ startAt: v }, "Change when blocks start", "start")} />
              </Field>
              <Toggle label="Settle flat again" value={bl.stopAt !== null} onChange={(v) => setBl({ stopAt: v ? Math.max(bl.startAt + bl.ramp, lenS - 0.5) : null }, v ? "Settle flat again" : "Keep moving", "stop-on")} />
              {bl.stopAt !== null && (
                <Field label="Flat again by" help="Seconds into this layer.">
                  <Slider label="Blocks flat by" value={bl.stopAt} min={bl.startAt} max={Math.max(bl.startAt + 0.1, lenS)} step={1 / 30} unit="s" onChange={(v) => setBl({ stopAt: v }, "Change when blocks settle", "stop")} />
                </Field>
              )}
              <Field label="Gets going over" help="Seconds to start moving, and to settle.">
                <Slider label="Blocks ease" value={bl.ramp} min={0} max={5} step={0.1} unit="s" onChange={(v) => setBl({ ramp: v }, "Change easing", "ramp")} />
              </Field>
              {bl.pattern === "random" || bl.pattern === "pulse" ? (
                <button className="ghost" onClick={() => setBl({ seed: bl.seed + 1 }, "Shuffle the blocks", "seed")}>
                  Shuffle the blocks
                </button>
              ) : null}
            </>
          )}
        </Section>
      )}

      {L && (
        <Section title="Light" open>
          <Field label="Kind">
            <Choice
              label="Light kind"
              value={L.type}
              choices={[
                { value: "directional", label: "Sun (parallel)" },
                { value: "spot", label: "Spot" },
                { value: "point", label: "Bulb" },
                { value: "ambient", label: "Soft fill" },
              ]}
              onChange={(v) => setLight({ type: v as Light3D["type"] }, "Change light kind", "type")}
            />
          </Field>
          <Field label="Brightness">
            <div className="row gap">
              <Slider label="Brightness" value={cur(L.intensity)} min={0} max={20} step={0.1} onChange={(v) => setLight({ intensity: setPropNow(layer, L.intensity, v) }, "Change brightness", "intensity")} />
              <KeyButton layer={layer} prop={L.intensity} label="brightness" onChange={(p) => setLight({ intensity: p as AnimProp<number> }, "Animate brightness", "intensity-key")} />
            </div>
          </Field>
          <Field label="Colour">
            <ColorField label="Light colour" value={[...L.color]} onChange={(v) => setLight({ color: v as unknown as RGBA }, "Change light colour", "color")} />
          </Field>
          {L.type !== "ambient" && (
            <>
              <Toggle label="Casts shadows" value={L.castShadow} onChange={(v) => setLight({ castShadow: v }, v ? "Cast shadows" : "No shadows", "shadow")} />
              <Field label="Part of the picture's own lighting" help="On: the building's picture is evened out by this light, so at rest it shows exactly (a sun, a soft fill). Off: it adds light and shadows on top of the picture (a lantern, a glow, a passing beam).">
                <Toggle label="Part of the picture's own lighting" value={balancesPicture(L)} onChange={(v) => setLight({ balance: v }, v ? "Light is part of the picture's lighting" : "Light adds to the picture", "balance")} />
              </Field>
              <Field label="Shadow softness">
                <Slider label="Shadow softness" value={L.softness} min={0} max={1} step={0.05} onChange={(v) => setLight({ softness: v }, "Change softness", "soft")} />
              </Field>
              {L.type !== "point" && <Vec3Sliders label="Aim at" value={L.target} min={[-W, -2, -10]} max={[W, H + 10, 20]} step={0.05} unit="m" onChange={(v) => setLight({ target: v }, "Aim light", "target")} />}
              {(L.type === "spot" || L.type === "point") && (
                <>
                  <Field label="Reaches" help="Metres beyond which it lights nothing, fading smoothly to it (its shadows reach as far). 0: no limit.">
                    <Slider label="Light range" value={L.range ?? 0} min={0} max={60} step={0.1} unit="m" onChange={(v) => setLight({ range: v > 0 ? v : undefined }, "Change how far the light reaches", "range")} />
                  </Field>
                  <Field label="Falloff" help="How it weakens with distance: 2 as real light, lower reaches further, 0 not at all.">
                    <Slider label="Light falloff" value={L.falloff ?? 2} min={0} max={3} step={0.05} onChange={(v) => setLight({ falloff: v }, "Change the light's falloff", "falloff")} />
                  </Field>
                </>
              )}
              {L.type === "spot" && (
                <Field label="Beam width">
                  <Slider label="Beam width" value={L.angle} min={5} max={80} step={1} unit="°" onChange={(v) => setLight({ angle: v }, "Change beam width", "angle")} />
                </Field>
              )}
            </>
          )}
        </Section>
      )}
        </>
      )}
    </div>
  );
};

/** Particles: how many, how big and fast, how long they last, wind, colour, and when they're born. */
const ParticlesEditor = ({ p, lenS, set }: { p: Particles3D; lenS: number; set: (c: Partial<Particles3D>, label: string, key: string) => void }) => {
  const preset = PARTICLE_PRESETS[p.kind];
  const base = preset.settings;
  return (
    <Section title="Particles" open>
      <p className="muted small">
        {preset.description} <span className="badge">procedural</span> Placed by rule (drag, gravity, wind), not simulated: they don't hit the house.
      </p>
      <Field label={p.kind === "confetti" ? "Pieces per second (during the burst)" : "Amount"} help="How many are born each second.">
        <Slider label="Amount" value={p.rate} min={1} max={base.rate * 4} step={1} unit="/s" onChange={(v) => set({ rate: v }, "Change amount", "rate")} />
      </Field>
      <Field label="Size">
        <Slider label="Size" value={Math.round(p.size * 100)} min={1} max={Math.max(30, Math.round(base.size * 400))} step={1} unit="cm" onChange={(v) => set({ size: v / 100 }, "Change particle size", "size")} />
      </Field>
      <Field label={p.kind === "snow" ? "Falling speed" : "Speed"}>
        <Slider label="Speed" value={p.speed} min={0.1} max={Math.max(2, base.speed * 3)} step={0.1} unit="m/s" onChange={(v) => set({ speed: v }, "Change particle speed", "speed")} />
      </Field>
      {p.kind !== "snow" && (
        <Field label="Each lasts">
          <Slider label="Each lasts" value={p.life} min={0.2} max={Math.max(3, base.life * 3)} step={0.1} unit="s" onChange={(v) => set({ life: v }, "Change how long particles last", "life")} />
        </Field>
      )}
      <Field label="Wind" help="Sideways: left is negative, right positive.">
        <Slider label="Wind" value={p.wind} min={-5} max={5} step={0.1} unit="m/s" onChange={(v) => set({ wind: v }, "Change wind", "wind")} />
      </Field>
      {p.colors.map((c, i) => {
        const label =
          p.kind === "snow" ? "Colour" : p.kind === "confetti" ? `Colour ${i + 1}` : p.colors.length === 1 ? "Colour" : i === 0 ? "Hottest colour (when born)" : i === p.colors.length - 1 ? "Coolest colour (as it dies)" : "Cooling colour";
        return (
          <Field key={i} label={label}>
            <div className="row gap">
              <ColorField label={label} value={[...c]} onChange={(v) => set({ colors: p.colors.map((x, j) => (j === i ? (v as unknown as RGBA) : x)) }, "Change particle colour", `color-${i}`)} />
              {p.kind === "confetti" && p.colors.length > 1 && (
                <button className="ghost small-btn" aria-label={`Remove ${label}`} onClick={() => set({ colors: p.colors.filter((_, j) => j !== i) }, "Remove a confetti colour", "colors")}>
                  ✕
                </button>
              )}
            </div>
          </Field>
        );
      })}
      {p.kind === "confetti" && p.colors.length < 8 && (
        <button className="ghost small-btn" onClick={() => set({ colors: [...p.colors, [1, 1, 1, 1]] }, "Add a confetti colour", "colors")}>
          + Colour
        </button>
      )}
      <Field label="Born from (seconds)">
        <Slider label="Born from" value={p.start} min={0} max={Math.max(1, lenS)} step={0.1} unit="s" onChange={(v) => set({ start: v, ...(p.stop !== null && p.stop <= v ? { stop: v + 0.3 } : {}) }, "Change when particles start", "start")} />
      </Field>
      <Toggle label="Stop being born before the end" value={p.stop !== null} onChange={(v) => set({ stop: v ? Math.min(lenS, p.start + 2) : null }, v ? "Stop particles early" : "Particles until the end", "stop-on")} />
      {p.stop !== null && (
        <Field label="Until (seconds)">
          <Slider label="Until" value={p.stop} min={p.start + 0.05} max={Math.max(p.start + 0.1, lenS)} step={0.05} unit="s" onChange={(v) => set({ stop: v }, "Change when particles stop", "stop")} />
        </Field>
      )}
      <button className="ghost" onClick={() => set({ seed: p.seed + 1 }, "Shuffle the particles", "seed")}>
        Shuffle
      </button>
    </Section>
  );
};
