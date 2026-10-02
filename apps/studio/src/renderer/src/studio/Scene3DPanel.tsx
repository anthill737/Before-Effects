/**
 * Inspector for a 3D layer: its objects, gravity, whether pieces stay inside the area, and the
 * selected object's position, look, physics, breaking apart and light. Values with ◆ can be
 * animated: click ◆ to add a keyframe at the playhead; once animated, changing the value sets a
 * keyframe at the playhead.
 */
import { type AnimProp, DEFAULT_FRACTURE, evalProp, type Fracture3D, keyAt, type Layer, type Light3D, type Material3D, type Object3D, type Physics3D, type PropValue, type RGBA, type Scene3D, timeToSeconds, type Vec3 } from "@be/core";
import { type ReactNode, useState } from "react";
import { addObject, layerTime, removeObject, sceneArea, setContain, setPropNow, toggleKeyNow, updateObject, use3D } from "./actions3d.ts";
import { Choice, ColorField, Field, Slider, Toggle } from "./controls.tsx";
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

export const Scene3DPanel = ({ layer }: { layer: Layer }) => {
  const project = useStudio((s) => s.project)!;
  useStudio((s) => s.version);
  useStudio((s) => s.time);
  const picked = use3D((s) => s.objectId);
  const scene: Scene3D | undefined = layer.source.kind === "scene3d" ? project.scenes3d?.[layer.source.sceneId] : undefined;
  const [adding, setAdding] = useState(false);
  if (!scene) return <p className="muted small">This 3D layer's scene is missing.</p>;
  const o = scene.objects[picked ?? ""] ?? scene.objects[scene.objectOrder[0] ?? ""];
  const g = Math.hypot(...scene.gravity);
  const gAngle = g > 0 ? Math.round((Math.atan2(scene.gravity[0], -scene.gravity[1]) * 180) / Math.PI) : 0;
  const setGravity = (strength: number, angle: number) => {
    const a = (angle * Math.PI) / 180;
    useStudio.getState().apply({ type: "scene3d.update", args: { sceneId: scene.id, changes: { gravity: [Math.sin(a) * strength, -Math.cos(a) * strength, 0] } } }, { label: "Change gravity", coalesceKey: `${scene.id}:gravity` });
  };
  const contained = layer.masks.some((m) => m.id === "contain");
  const area = sceneArea(scene);
  return (
    <div className="inspector-body scene3d-panel">
      <div className="panel-head">
        <h2>{scene.name}</h2>
      </div>
      <p className="muted small">3D objects in front of the building, seen through the show camera. Orbit around them in “3D projection”.</p>
      <PhysicsStatus layerId={layer.id} />
      {area && (
        <Field label="Pieces and effects" help="Projector blackout areas (“Keep light off here”) apply either way.">
          <div className="segmented" role="radiogroup" aria-label="Pieces and effects">
            <button role="radio" aria-checked={contained} className={contained ? "on" : ""} onClick={() => setContain(layer, true)}>
              Contain within the area
            </button>
            <button role="radio" aria-checked={!contained} className={!contained ? "on" : ""} onClick={() => setContain(layer, false)}>
              Extend beyond
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
              <span aria-hidden="true">{x.kind === "light" ? "☀ " : x.fracture ? "▦ " : "■ "}</span>
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
      </Section>

      {o && <ObjectEditor key={o.id} layer={layer} scene={scene} o={o} />}
    </div>
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

      <Section title={L ? "Position" : "Position, turn and size"} open>
        <div className="row gap key-row">
          <span className="small muted grow">{(o.position.keyframes?.length ?? 0) > 0 ? `Animated (${o.position.keyframes!.length} keyframes)` : "Position"}</span>
          <KeyButton layer={layer} prop={o.position} label="position" onChange={(p) => up({ position: p }, "Animate position", "position-key")} />
        </div>
        <Vec3Sliders label={L ? "Light position" : "Position"} value={pos} min={[-W, -2, -10]} max={[W, H + 10, 20]} step={0.05} unit="m" onChange={(v) => anim("position", o.position, v, "Move 3D object")} />
        {!L && (
          <>
            <Vec3Sliders label="Turn" value={cur(o.rotation)} min={[-180, -180, -180]} max={[180, 180, 180]} step={1} unit="°" onChange={(v) => anim("rotation", o.rotation, v, "Turn 3D object")} />
            <Field label="Size">
              <Slider label="Size" value={cur(o.scale)[0]} min={10} max={400} step={1} unit="%" onChange={(v) => anim("scale", o.scale, [v, v, v] as Vec3, "Resize 3D object")} />
            </Field>
          </>
        )}
        {o.geometry?.kind === "area" && (
          <Field label="Thickness" help="How deep the solid is behind the building front.">
            <Slider label="Thickness" value={Math.round(o.geometry.depth * 100)} min={2} max={200} step={1} unit="cm" onChange={(v) => up({ geometry: { ...o.geometry, depth: v / 100 } }, "Change thickness", "depth")} />
          </Field>
        )}
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
                { value: "shadow", label: "Shadows only" },
              ]}
              onChange={(v) => setMat({ style: v as Material3D["style"] }, "Change surface", "style")}
            />
          </Field>
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
              <Field label="Roughness">
                <Slider label="Roughness" value={m.roughness} min={0} max={1} step={0.05} onChange={(v) => setMat({ roughness: v }, "Change roughness", "rough")} />
              </Field>
            </>
          )}
          {m.style === "shadow" && (
            <Field label="Shadow darkness">
              <Slider label="Shadow darkness" value={m.opacity} min={0} max={1} step={0.05} onChange={(v) => setMat({ opacity: v }, "Change shadow darkness", "opacity")} />
            </Field>
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
            </>
          )}
        </Section>
      )}

      {o.geometry?.kind === "area" && (
        <Section title="Breaking apart" open={!!fr}>
          <Toggle
            label="Collapse and rebuild"
            value={!!fr}
            onChange={(v) => up(v ? { fracture: { ...DEFAULT_FRACTURE, collapseAt: Math.min(1, lenS / 4) }, physics: { ...(ph ?? { mass: 2000, friction: 0.7, bounce: 0.15 }), body: "dynamic" } } : { fracture: null }, v ? "Make it collapse" : "Stop it collapsing", "fracture")}
          />
          {fr && (
            <>
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
              <Field label="Push toward the audience">
                <Slider label="Push" value={fr.push} min={0} max={8} step={0.1} unit="m/s" onChange={(v) => setFr({ push: v }, "Change push", "push")} />
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
              <Field label="Shadow softness">
                <Slider label="Shadow softness" value={L.softness} min={0} max={1} step={0.05} onChange={(v) => setLight({ softness: v }, "Change softness", "soft")} />
              </Field>
              {L.type !== "point" && <Vec3Sliders label="Aim at" value={L.target} min={[-W, -2, -10]} max={[W, H + 10, 20]} step={0.05} unit="m" onChange={(v) => setLight({ target: v }, "Aim light", "target")} />}
              {L.type === "spot" && (
                <Field label="Beam width">
                  <Slider label="Beam width" value={L.angle} min={5} max={80} step={1} unit="°" onChange={(v) => setLight({ angle: v }, "Change beam width", "angle")} />
                </Field>
              )}
            </>
          )}
        </Section>
      )}
    </div>
  );
};
