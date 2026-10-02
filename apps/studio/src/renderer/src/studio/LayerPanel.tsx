/** Inspector for a plain layer: pictures and videos, text, and sound. Simple controls first. */
import { type AnimProp, defaultAudio, evalProp, formatSecondsFriendly, keyAt, type Layer, type PropValue, secondsToTime, type Vec3 } from "@be/core";
import { ColorField, Field, Slider, Toggle } from "./controls.tsx";
import { layerLocal, setLayerValue, toggleLayerKey } from "./layerKeys.ts";
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

  return (
    <div className="inspector-body">
      <div className="panel-head">
        <h2>{layer.name}</h2>
      </div>
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

      {hasSound && audio && (
        <>
          <h3 className="subhead">Sound</h3>
          <Field label="Volume" help="0 dB plays the file as it is; lower is quieter.">
            <Slider value={staticValue<number>(audio.volume, time)} min={-60} max={12} step={0.5} unit="dB" onChange={(v) => setField("audio", { ...audio, volume: { value: v } }, "Volume")} label="Volume" />
          </Field>
          <Field label="Left / right">
            <Slider value={staticValue<number>(audio.pan, time)} min={-1} max={1} step={0.05} onChange={(v) => setField("audio", { ...audio, pan: { value: v } }, "Pan")} label="Pan" />
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
