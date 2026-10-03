/** Inspector for a plain layer: pictures and videos, text, and sound. Simple controls first. */
import { type AnimProp, defaultAudio, type EffectSettingSpec, evalProp, formatSecondsFriendly, isColorSetting, keyAt, LAYER_EFFECTS, type Layer, newEffect, newId, type PropValue, secondsToTime, type Vec3 } from "@be/core";
import { Choice, ColorField, Field, Slider, Toggle } from "./controls.tsx";
import { layerLocal, setLayerValue, toggleLayerKey } from "./layerKeys.ts";
import { BlenderLinkSection } from "./BlenderPanel.tsx";
import { currentComp, useStudio } from "./store.ts";

/** ◆: add a keyframe at the playhead (starting animation) or remove the one there. */
const KeyToggle = ({ layer, path, prop, label }: { layer: Layer; path: string; prop: AnimProp; label: string }) => {
  const time = useStudio((s) => s.time);
  const comp = currentComp(useStudio.getState())!;
  const on = !!keyAt(prop, layerLocal(layer, time));
  const animated = (prop.keyframes?.length ?? 0) > 0;
  return (
    <button
      className={`key-btn ${on ? "on" : animated ? "animated" : ""}`}
      aria-pressed={on}
      aria-label={on ? `Remove the ${label} keyframe at the playhead` : `Add a ${label} keyframe at the playhead`}
      title={on ? "Remove the keyframe here" : animated ? "Add a keyframe here (this value is animated: changing it adds one too)" : "Animate: add a keyframe at the playhead"}
      onClick={() => toggleLayerKey(comp, layer, path, prop)}
    >
      ◆
    </button>
  );
};

/**
 * The layer's effects (blur, glow, melt, ripple, glitch): every setting of each, numbers and colours,
 * each with ◆ for keyframes, on/off, remove, and adding more. Effects a recipe made are adjusted from
 * the recipe's own settings too.
 */
const LayerEffects = ({ layer }: { layer: Layer }) => {
  const time = useStudio((s) => s.time);
  const comp = currentComp(useStudio.getState())!;
  const apply = useStudio.getState().apply;
  const lt = layerLocal(layer, time);
  const setEffects = (effects: Layer["effects"], label: string) => apply({ type: "layer.update", args: { compId: comp.id, layerId: layer.id, changes: { effects } } }, { label });
  return (
    <section className="layer-effects" aria-label="Effects">
      <h3 className="subhead">Effects</h3>
      {layer.effects.length === 0 && <p className="muted small">None. Add one below.</p>}
      {layer.effects.map((e) => {
        const spec = LAYER_EFFECTS[e.type];
        return (
          <div key={e.id} className="effect-card">
            <div className="row gap">
              <strong className="grow">{spec?.title ?? e.type}</strong>
              <button className="ghost small-btn" onClick={() => setEffects(layer.effects.map((x) => (x.id === e.id ? { ...x, enabled: !x.enabled } : x)), e.enabled ? "Turn effect off" : "Turn effect on")}>
                {e.enabled ? "On" : "Off"}
              </button>
              <button className="ghost small-btn danger" aria-label={`Remove ${spec?.title ?? e.type}`} onClick={() => setEffects(layer.effects.filter((x) => x.id !== e.id), "Remove effect")}>
                ✕
              </button>
            </div>
            {spec && <p className="muted small">{spec.description}</p>}
            {(spec?.params ?? Object.keys(e.params).map((key): EffectSettingSpec => ({ key, label: key, min: 0, max: 100, step: 0.1, default: 0 }))).map((ps) => {
              const prop = e.params[ps.key];
              if (!prop) return null;
              const path = `effects.${e.id}.params.${ps.key}`;
              const v = evalProp(prop, lt);
              return (
                <Field key={ps.key} label={ps.label} help={ps.help}>
                  <div className="row gap">
                    {isColorSetting(ps) ? (
                      <ColorField value={typeof v === "number" ? ps.default : v} onChange={(c) => setLayerValue(comp, layer, path, prop, c, `Change ${ps.label.toLowerCase()}`)} label={`${spec?.title ?? e.type} ${ps.label}`} />
                    ) : (
                      <Slider value={typeof v === "number" ? v : 0} min={ps.min} max={ps.max} step={ps.step} unit={ps.unit} onChange={(nv) => setLayerValue(comp, layer, path, prop as AnimProp<number>, nv, `Change ${ps.label.toLowerCase()}`)} label={`${spec?.title ?? e.type} ${ps.label}`} />
                    )}
                    <KeyToggle layer={layer} path={path} prop={prop} label={`${(spec?.title ?? e.type).toLowerCase()} ${ps.label.toLowerCase()}`} />
                  </div>
                </Field>
              );
            })}
          </div>
        );
      })}
      <div className="row gap wrap">
        {Object.entries(LAYER_EFFECTS).map(([type, spec]) => (
          <button key={type} className="ghost small-btn" title={spec.description} onClick={() => setEffects([...layer.effects, newEffect(type, newId("fx"))], `Add ${spec.title.toLowerCase()}`)}>
            + {spec.title}
          </button>
        ))}
      </div>
    </section>
  );
};

export const BLEND_CHOICES = [
  { value: "normal", label: "Cover what's below" },
  { value: "add", label: "Add light" },
  { value: "screen", label: "Lighten" },
  { value: "multiply", label: "Tint (darken)" },
] as const;

/** Name, show/hide and how it mixes with the layers below: for every kind of layer. */
export const LayerIdentity = ({ layer }: { layer: Layer }) => {
  const comp = currentComp(useStudio.getState())!;
  const apply = useStudio.getState().apply;
  const update = (changes: Partial<Layer>, label: string, key: string) => apply({ type: "layer.update", args: { compId: comp.id, layerId: layer.id, changes } }, { label, coalesceKey: `${layer.id}:${key}` });
  return (
    <>
      <Field label="Layer name">
        <div className="row gap">
          <input className="text-input grow" value={layer.name} aria-label="Layer name" onChange={(e) => e.target.value.trim() && update({ name: e.target.value }, "Rename layer", "name")} />
          <button className="ghost small-btn" onClick={() => update({ enabled: !layer.enabled }, layer.enabled ? "Hide layer" : "Show layer", "enabled")}>
            {layer.enabled ? "Hide" : "Show"}
          </button>
        </div>
      </Field>
      <Field label="Mix with what's below" help="Add light suits glows, sparks and fire on a dark house; Cover hides what's underneath.">
        <Choice label="Mix with what's below" value={layer.blendMode} choices={BLEND_CHOICES} onChange={(v) => update({ blendMode: v as Layer["blendMode"] }, "Change how the layer mixes", "blend")} />
      </Field>
    </>
  );
};

/** Opacity (◆) and when the layer plays: used where a layer has its own panel (3D layers). */
export const LayerTiming = ({ layer }: { layer: Layer }) => {
  const time = useStudio((s) => s.time);
  const comp = currentComp(useStudio.getState())!;
  const apply = useStudio.getState().apply;
  const lt = layerLocal(layer, time);
  return (
    <>
      <Field label="Opacity">
        <div className="row gap">
          <Slider value={evalProp(layer.transform.opacity, lt) as number} min={0} max={100} unit="%" onChange={(v) => setLayerValue(comp, layer, "transform.opacity", layer.transform.opacity, v, "Opacity")} label="Opacity" />
          <KeyToggle layer={layer} path="transform.opacity" prop={layer.transform.opacity} label="opacity" />
        </div>
      </Field>
      <Field label="Starts at">
        <Slider
          value={Math.round((layer.inPoint / secondsToTime(1)) * 10) / 10}
          min={0}
          max={Math.max(1, comp.duration / secondsToTime(1))}
          step={0.1}
          unit="s"
          onChange={(v) => {
            const shift = secondsToTime(v) - layer.inPoint;
            apply({ type: "layer.update", args: { compId: comp.id, layerId: layer.id, changes: { startTime: layer.startTime + shift, inPoint: layer.inPoint + shift, outPoint: layer.outPoint + shift } } }, { label: "Move in time", coalesceKey: `${layer.id}:start` });
          }}
          label="Starts at"
        />
      </Field>
      <Field label="Length">
        <Slider
          value={Math.round(((layer.outPoint - layer.inPoint) / secondsToTime(1)) * 10) / 10}
          min={0.1}
          max={Math.max(0.2, (comp.duration - layer.inPoint) / secondsToTime(1))}
          step={0.1}
          unit="s"
          onChange={(v) => apply({ type: "layer.update", args: { compId: comp.id, layerId: layer.id, changes: { outPoint: layer.inPoint + secondsToTime(v) } } }, { label: "Change length", coalesceKey: `${layer.id}:len` })}
          label="Length"
        />
      </Field>
    </>
  );
};

const MASK_MODES = [
  { value: "add", label: "Show inside" },
  { value: "subtract", label: "Cut out" },
  { value: "intersect", label: "Only where shapes overlap" },
  { value: "none", label: "Off" },
];

/** Every setting of the layer's clipping shapes (masks): how each clips, invert, soft edge, grow, strength. */
export const LayerMasks = ({ layer }: { layer: Layer }) => {
  const time = useStudio((s) => s.time);
  const comp = currentComp(useStudio.getState())!;
  const apply = useStudio.getState().apply;
  const lt = layerLocal(layer, time);
  if (!layer.masks.length) return null;
  const setMask = (id: string, changes: Record<string, unknown>, label: string) =>
    apply({ type: "layer.update", args: { compId: comp.id, layerId: layer.id, changes: { masks: layer.masks.map((m) => (m.id === id ? { ...m, ...changes } : m)) } } }, { label, coalesceKey: `${layer.id}:${id}:${label}` });
  return (
    <section aria-label="Clipping">
      <h3 className="subhead">Clipping</h3>
      {layer.masks.map((m) => (
        <div key={m.id} className="effect-card">
          <strong>{m.name}</strong>
          <Field label="Clips">
            <Choice label={`${m.name} clips`} value={MASK_MODES.some((x) => x.value === m.mode) ? m.mode : "add"} choices={MASK_MODES} onChange={(v) => setMask(m.id, { mode: v }, "Change clipping")} />
          </Field>
          <Field label="Inverted" help="Show outside the shape instead of inside.">
            <Toggle label={`${m.name} inverted`} value={m.inverted} onChange={(v) => setMask(m.id, { inverted: v }, "Invert clipping")} />
          </Field>
          {(
            [
              ["feather", "Soft edge", 0, 200, "px"],
              ["expansion", "Grow / shrink", -200, 200, "px"],
              ["opacity", "Strength", 0, 100, "%"],
            ] as const
          ).map(([k, label, min, max, unit]) => (
            <Field key={k} label={label}>
              <div className="row gap">
                <Slider value={evalProp(m[k], lt) as number} min={min} max={max} unit={unit} onChange={(v) => setLayerValue(comp, layer, `masks.${m.id}.${k}`, m[k], v, label)} label={`${m.name} ${label}`} />
                <KeyToggle layer={layer} path={`masks.${m.id}.${k}`} prop={m[k]} label={`${m.name} ${label.toLowerCase()}`} />
              </div>
            </Field>
          ))}
        </div>
      ))}
    </section>
  );
};

export const FONTS = ["Segoe UI", "Arial", "Bahnschrift", "Georgia", "Impact", "Times New Roman", "Trebuchet MS", "Verdana", "Consolas", "Cascadia Code", "Comic Sans MS", "Segoe Script"];

const staticValue = <V,>(p: AnimProp<V & (number | readonly number[])>, t: number) => evalProp(p, t) as V;

export const LayerPanel = ({ layer }: { layer: Layer }) => {
  const project = useStudio((s) => s.project)!;
  const time = useStudio((s) => s.time);
  const comp = currentComp(useStudio.getState())!;
  const apply = useStudio.getState().apply;
  /** Change a value at the playhead (a keyframe there when it's animated). */
  const set = <V extends PropValue>(path: string, prop: AnimProp<V>, value: V, label: string) => setLayerValue(comp, layer, path, prop, value, label);
  const lt = layerLocal(layer, time);
  const setField = (path: string, value: unknown, label: string) => apply({ type: "layer.setPath", args: { compId: comp.id, layerId: layer.id, path, value } }, { label, coalesceKey: `${layer.id}:${path}` });
  const asset = layer.source.kind === "footage" || layer.source.kind === "audio" ? project.assets[layer.source.assetId] : undefined;
  const hasSound = layer.source.kind === "audio" || !!asset?.audioPath;
  const audio = layer.audio ?? (hasSound ? defaultAudio() : undefined);

  const madeInBlender = Object.values(project.blenderLinks ?? {}).find((l) => l.layerId === layer.id);
  return (
    <div className="inspector-body">
      <div className="panel-head">
        <h2>{layer.name}</h2>
      </div>
      {madeInBlender && <BlenderLinkSection link={madeInBlender} />}
      <LayerIdentity layer={layer} />
      <p className="muted small">
        {layer.source.kind === "audio" ? "Sound" : layer.source.kind === "text" ? "Text" : asset?.kind === "video" ? "Video" : asset?.kind === "image" ? "Picture" : "Layer"} · {formatSecondsFriendly(layer.inPoint)}–{formatSecondsFriendly(layer.outPoint)}
        {asset ? ` · ${asset.name}` : ""}
      </p>

      {layer.source.kind === "text" && (
        <>
          <Field label="Text">
            <textarea className="text-input" rows={3} value={layer.source.doc.text} onChange={(e) => setField("source.doc.text", e.target.value, "Change text")} aria-label="Text" />
          </Field>
          <Field label="Font">
            <select className="select" value={layer.source.doc.font} onChange={(e) => setField("source.doc.font", e.target.value, "Change font")} aria-label="Font">
              {[...new Set([layer.source.doc.font, ...FONTS])].map((f) => (
                <option key={f} value={f} style={{ fontFamily: f }}>
                  {f}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Size">
            <div className="row gap">
              <Slider value={staticValue<number>(layer.source.doc.size, lt)} min={6} max={600} unit="px" onChange={(v) => layer.source.kind === "text" && set("source.doc.size", layer.source.doc.size, v, "Text size")} label="Text size" />
              <KeyToggle layer={layer} path="source.doc.size" prop={layer.source.doc.size} label="text size" />
            </div>
          </Field>
          <Field label="Color">
            <div className="row gap">
              <ColorField value={staticValue<readonly number[]>(layer.source.doc.color, lt)} onChange={(v) => layer.source.kind === "text" && set("source.doc.color", layer.source.doc.color, v, "Text color")} label="Text color" />
              <KeyToggle layer={layer} path="source.doc.color" prop={layer.source.doc.color} label="text colour" />
            </div>
          </Field>
          <Field label="Weight">
            <Choice
              label="Weight"
              value={String(layer.source.doc.weight)}
              choices={[
                { value: "300", label: "Light" },
                { value: "400", label: "Regular" },
                { value: "600", label: "Semibold" },
                { value: "700", label: "Bold" },
                { value: "900", label: "Heavy" },
              ]}
              onChange={(v) => setField("source.doc.weight", Number(v), "Text weight")}
            />
          </Field>
          <Field label="Line up">
            <Choice label="Line up" value={layer.source.doc.align} choices={[{ value: "left", label: "Left" }, { value: "center", label: "Centre" }, { value: "right", label: "Right" }]} onChange={(v) => setField("source.doc.align", v, "Text alignment")} />
          </Field>
          <Field label="Line spacing">
            <Slider value={layer.source.doc.lineHeight} min={0.7} max={3} step={0.05} onChange={(v) => setField("source.doc.lineHeight", v, "Line spacing")} label="Line spacing" />
          </Field>
          <Field label="Letter spacing">
            <Slider value={layer.source.doc.tracking} min={-20} max={100} unit="px" onChange={(v) => setField("source.doc.tracking", v, "Letter spacing")} label="Letter spacing" />
          </Field>
          <Field label="Outline">
            <Toggle
              label="Outline"
              value={!!layer.source.doc.stroke}
              onChange={(v) => setField("source.doc.stroke", v ? { color: { value: [0, 0, 0, 1] }, width: { value: 4 } } : undefined, v ? "Add outline" : "Remove outline")}
            />
          </Field>
          {layer.source.doc.stroke && (
            <>
              <Field label="Outline colour">
                <div className="row gap">
                  <ColorField value={staticValue<readonly number[]>(layer.source.doc.stroke.color, lt)} onChange={(v) => layer.source.kind === "text" && layer.source.doc.stroke && set("source.doc.stroke.color", layer.source.doc.stroke.color, v, "Outline colour")} label="Outline colour" />
                  <KeyToggle layer={layer} path="source.doc.stroke.color" prop={layer.source.doc.stroke.color} label="outline colour" />
                </div>
              </Field>
              <Field label="Outline width">
                <div className="row gap">
                  <Slider value={staticValue<number>(layer.source.doc.stroke.width, lt)} min={0} max={40} step={0.5} unit="px" onChange={(v) => layer.source.kind === "text" && layer.source.doc.stroke && set("source.doc.stroke.width", layer.source.doc.stroke.width, v, "Outline width")} label="Outline width" />
                  <KeyToggle layer={layer} path="source.doc.stroke.width" prop={layer.source.doc.stroke.width} label="outline width" />
                </div>
              </Field>
            </>
          )}
        </>
      )}

      {layer.source.kind !== "audio" && (
        <>
          <p className="muted small">◆ animates a value: it adds a keyframe at the playhead; after that, changing the value adds another. Keyframes show on the layer's bar — click one for its easing.</p>
          <Field label="Opacity">
            <div className="row gap">
              <Slider value={staticValue<number>(layer.transform.opacity, lt)} min={0} max={100} unit="%" onChange={(v) => set("transform.opacity", layer.transform.opacity, v, "Opacity")} label="Opacity" />
              <KeyToggle layer={layer} path="transform.opacity" prop={layer.transform.opacity} label="opacity" />
            </div>
          </Field>
        </>
      )}
      {(layer.source.kind === "footage" || layer.source.kind === "text") && (
        <>
          <Field label="Size on the building">
            <div className="row gap">
              <Slider value={staticValue<readonly number[]>(layer.transform.scale, lt)[0]!} min={1} max={400} unit="%" onChange={(v) => set("transform.scale", layer.transform.scale, [v, v, 100] as Vec3, "Resize")} label="Size" />
              <KeyToggle layer={layer} path="transform.scale" prop={layer.transform.scale} label="size" />
            </div>
          </Field>
          {(["Width", "Height"] as const).map((axis, i) => (
            <Field key={axis} label={`${axis} only`}>
              <Slider
                value={staticValue<readonly number[]>(layer.transform.scale, lt)[i]!}
                min={1}
                max={400}
                unit="%"
                onChange={(v) => {
                  const cur = [...staticValue<readonly number[]>(layer.transform.scale, lt)] as [number, number, number];
                  cur[i] = v;
                  set("transform.scale", layer.transform.scale, cur as Vec3, "Resize");
                }}
                label={`${axis} only`}
              />
            </Field>
          ))}
          {(["left/right", "up/down"] as const).map((axis, i) => (
            <Field key={axis} label={`Position (${axis})`}>
              <div className="row gap">
                <Slider
                  value={Math.round(staticValue<readonly number[]>(layer.transform.position, lt)[i]!)}
                  min={-comp.width / 2}
                  max={comp.width * 1.5}
                  unit="px"
                  onChange={(v) => {
                    const cur = [...staticValue<readonly number[]>(layer.transform.position, lt)] as [number, number, number];
                    cur[i] = v;
                    set("transform.position", layer.transform.position, cur as Vec3, "Move");
                  }}
                  label={`Position ${axis}`}
                />
                {i === 0 && <KeyToggle layer={layer} path="transform.position" prop={layer.transform.position} label="position" />}
              </div>
            </Field>
          ))}
          <Field label="Turn">
            <div className="row gap">
              <Slider
                value={Math.round(staticValue<readonly number[]>(layer.transform.rotation, lt)[2] ?? 0)}
                min={-360}
                max={360}
                unit="°"
                onChange={(v) => {
                  const cur = [...staticValue<readonly number[]>(layer.transform.rotation, lt)] as [number, number, number];
                  cur[2] = v;
                  set("transform.rotation", layer.transform.rotation, cur as Vec3, "Turn");
                }}
                label="Turn"
              />
              <KeyToggle layer={layer} path="transform.rotation" prop={layer.transform.rotation} label="turn" />
            </div>
          </Field>
        </>
      )}

      {layer.source.kind !== "audio" && <LayerEffects layer={layer} />}
      {layer.source.kind !== "audio" && <LayerMasks layer={layer} />}
      {layer.source.kind === "footage" && asset?.kind === "video" && (
        <Field label="Loop" help="Play the video again from the start when it ends.">
          <Toggle label="Loop" value={!!layer.source.loop} onChange={(v) => setField("source.loop", v, v ? "Loop the video" : "Play once")} />
        </Field>
      )}

      {hasSound && audio && (
        <>
          <h3 className="subhead">Sound</h3>
          <Field label="Volume" help="0 dB plays the file as it is; lower is quieter.">
            <div className="row gap">
              <Slider
                value={staticValue<number>(audio.volume, lt)}
                min={-60}
                max={12}
                step={0.5}
                unit="dB"
                onChange={(v) => (layer.audio ? set("audio.volume", layer.audio.volume, v, "Volume") : setField("audio", { ...audio, volume: { value: v } }, "Volume"))}
                label="Volume"
              />
              {layer.audio && <KeyToggle layer={layer} path="audio.volume" prop={layer.audio.volume} label="volume" />}
            </div>
          </Field>
          <Field label="Left / right">
            <div className="row gap">
              <Slider value={staticValue<number>(audio.pan, lt)} min={-1} max={1} step={0.05} onChange={(v) => (layer.audio ? set("audio.pan", layer.audio.pan, v, "Pan") : setField("audio", { ...audio, pan: { value: v } }, "Pan"))} label="Pan" />
              {layer.audio && <KeyToggle layer={layer} path="audio.pan" prop={layer.audio.pan} label="left/right" />}
            </div>
          </Field>
          <Field label="Fade in">
            <Slider value={audio.fadeIn} min={0} max={20} step={0.1} unit="s" onChange={(v) => setField("audio", { ...audio, fadeIn: v }, "Fade in")} label="Fade in" />
          </Field>
          <Field label="Fade out">
            <Slider value={audio.fadeOut} min={0} max={20} step={0.1} unit="s" onChange={(v) => setField("audio", { ...audio, fadeOut: v }, "Fade out")} label="Fade out" />
          </Field>
          <Field label="Mute">
            <Toggle value={audio.muted} onChange={(v) => setField("audio", { ...audio, muted: v }, v ? "Mute" : "Unmute")} label="Mute" />
          </Field>
          {asset?.analysis && (
            <p className="muted small">
              Beat found: {Math.round(asset.analysis.bpm)} BPM · {asset.analysis.beats.length} beats. “Move with the beat” uses these.
            </p>
          )}
        </>
      )}

      <h3 className="subhead">Timing</h3>
      <Field label="Starts at">
        <Slider
          value={Math.round((layer.inPoint / secondsToTime(1)) * 10) / 10}
          min={0}
          max={Math.max(1, comp.duration / secondsToTime(1))}
          step={0.1}
          unit="s"
          onChange={(v) => {
            const shift = secondsToTime(v) - layer.inPoint;
            apply({ type: "layer.update", args: { compId: comp.id, layerId: layer.id, changes: { startTime: layer.startTime + shift, inPoint: layer.inPoint + shift, outPoint: layer.outPoint + shift } } }, { label: "Move in time", coalesceKey: `${layer.id}:start` });
          }}
          label="Starts at"
        />
      </Field>
      <Field label="Length" help="Shorter trims the end; it never changes the source file.">
        <Slider
          value={Math.round(((layer.outPoint - layer.inPoint) / secondsToTime(1)) * 10) / 10}
          min={0.1}
          max={Math.max(0.2, (asset?.meta.duration ?? comp.duration) / secondsToTime(1))}
          step={0.1}
          unit="s"
          onChange={(v) => apply({ type: "layer.update", args: { compId: comp.id, layerId: layer.id, changes: { outPoint: layer.inPoint + secondsToTime(v) } } }, { label: "Trim", coalesceKey: `${layer.id}:len` })}
          label="Length"
        />
      </Field>
      <div className="row gap wrap">
        <button
          className="danger-ghost"
          onClick={() => {
            apply({ type: "layer.remove", args: { compId: comp.id, layerId: layer.id } }, { label: `Remove ${layer.name}` });
            useStudio.getState().selectLayer(null);
          }}
        >
          Remove from the show
        </button>
      </div>
    </div>
  );
};
