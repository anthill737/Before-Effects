/**
 * The menu on a keyframe diamond: how the motion leaves it (simple choices first), then — only if
 * asked for — a custom curve with a small picture of it, and deleting the keyframe.
 */
import { type AnimProp, EASE_PRESETS, type EasePreset, keyCurve, keyEase, setKeyCurve, setKeyEase } from "@be/core";
import { useState } from "react";
import { Slider } from "./controls.tsx";

/** The timing curve from this keyframe to the next (time across, progress up). */
const CurvePicture = ({ leave, arrive }: { leave: number; arrive: number }) => (
  <svg className="curve-picture" viewBox="0 0 100 60" aria-hidden="true">
    <path d="M5,55 H95 M5,55 V5" className="axes" />
    <path d={`M5,55 C${5 + 90 * leave},55 ${95 - 90 * arrive},5 95,5`} className="curve" />
  </svg>
);

export const KeyMenu = ({ prop, keyId, at, onChange, onClose }: { prop: AnimProp; keyId: string; at: { x: number; y: number }; onChange: (next: AnimProp, label: string, coalesceKey?: string) => void; onClose: () => void }) => {
  const [custom, setCustom] = useState(false);
  const cur = keyEase(prop, keyId);
  const curve = keyCurve(prop, keyId);
  const isLast = prop.keyframes?.at(-1)?.id === keyId;
  return (
    <div className="popover key-menu" style={{ left: at.x, top: at.y }} role="menu" aria-label="Keyframe easing">
      {!isLast && (
        <>
          <strong className="small">How it moves from here</strong>
          {EASE_PRESETS.map((e) => (
            <button
              key={e.id}
              role="menuitemradio"
              aria-checked={cur === e.id}
              className={`list-item ${cur === e.id ? "on" : ""}`}
              onClick={() => {
                onChange(setKeyEase(prop, keyId, e.id as EasePreset), "Change easing");
                onClose();
              }}
            >
              {e.label}
            </button>
          ))}
          {!custom ? (
            <button role="menuitem" className="list-item" onClick={() => setCustom(true)}>
              Custom curve…
            </button>
          ) : (
            <div className="custom-curve">
              <CurvePicture leave={curve.leave} arrive={curve.arrive} />
              <label className="small">Slow leaving</label>
              <Slider label="Slow leaving" value={Math.round(curve.leave * 100)} min={0} max={100} unit="%" onChange={(v) => onChange(setKeyCurve(prop, keyId, v / 100, curve.arrive), "Change curve", `${keyId}:curve`)} />
              <label className="small">Slow arriving</label>
              <Slider label="Slow arriving" value={Math.round(curve.arrive * 100)} min={0} max={100} unit="%" onChange={(v) => onChange(setKeyCurve(prop, keyId, curve.leave, v / 100), "Change curve", `${keyId}:curve`)} />
            </div>
          )}
        </>
      )}
      {isLast && <p className="muted small">The last keyframe: the value stays from here on.</p>}
      <button
        role="menuitem"
        className="list-item danger"
        onClick={() => {
          const hit = prop.keyframes!.find((k) => k.id === keyId)!;
          const rest = prop.keyframes!.filter((k) => k.id !== keyId);
          onChange(rest.length ? { ...prop, keyframes: rest } : { value: hit.v, ...(prop.spatial ? { spatial: true } : {}) }, "Delete keyframe");
          onClose();
        }}
      >
        Delete keyframe
      </button>
      <button role="menuitem" className="list-item" onClick={onClose}>
        Close
      </button>
    </div>
  );
};
