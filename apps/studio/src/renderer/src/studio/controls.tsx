/** Plain, large, keyboard-friendly controls used by the inspector. */
import { type ReactNode, useId } from "react";

export const Field = ({ label, help, children, badge }: { label: string; help?: string | undefined; children: ReactNode; badge?: ReactNode }) => {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        {label}
        {badge}
      </label>
      <div id={id} className="field-control">
        {children}
      </div>
      {help && <p className="field-help">{help}</p>}
    </div>
  );
};

export const Slider = ({
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step?: number | undefined;
  unit?: string | undefined;
  onChange: (v: number) => void;
  label: string;
}) => (
  <div className="slider">
    <input type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} />
    <input
      className="slider-number"
      type="number"
      min={min}
      max={max}
      step={step}
      value={Number.isInteger(step) ? Math.round(value) : Number(value.toFixed(2))}
      aria-label={`${label} value`}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
      }}
    />
    {unit && <span className="slider-unit">{unit}</span>}
  </div>
);

const toHex = (c: readonly number[]) =>
  `#${c
    .slice(0, 3)
    .map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
const fromHex = (h: string): [number, number, number, number] => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, 1];

const SWATCHES: Array<[number, number, number, number]> = [
  [1, 0.82, 0.5, 1],
  [1, 1, 1, 1],
  [0.78, 0.9, 1, 1],
  [0.3, 0.55, 1, 1],
  [0.3, 1, 0.85, 1],
  [0.45, 1, 0.35, 1],
  [1, 0.85, 0.2, 1],
  [1, 0.45, 0.15, 1],
  [1, 0.2, 0.3, 1],
  [1, 0.25, 0.75, 1],
  [0.65, 0.35, 1, 1],
];

export const ColorField = ({ value, onChange, label }: { value: readonly number[]; onChange: (v: [number, number, number, number]) => void; label: string }) => (
  <div className="color-field">
    <input type="color" value={toHex(value)} aria-label={label} onChange={(e) => onChange(fromHex(e.target.value))} />
    <div className="swatches" role="radiogroup" aria-label={`${label} presets`}>
      {SWATCHES.map((c) => (
        <button
          key={toHex(c)}
          className={`swatch ${toHex(c) === toHex(value) ? "on" : ""}`}
          style={{ background: toHex(c) }}
          role="radio"
          aria-checked={toHex(c) === toHex(value)}
          aria-label={toHex(c)}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  </div>
);

export const Choice = ({
  value,
  choices,
  onChange,
  label,
}: {
  value: string;
  choices: readonly { value: string; label: string }[];
  onChange: (v: string) => void;
  label: string;
}) =>
  choices.length <= 3 ? (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {choices.map((c) => (
        <button key={c.value} role="radio" aria-checked={c.value === value} className={c.value === value ? "on" : ""} onClick={() => onChange(c.value)}>
          {c.label}
        </button>
      ))}
    </div>
  ) : (
    <select className="select" value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}>
      {choices.map((c) => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
    </select>
  );

export const Toggle = ({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) => (
  <button className={`toggle ${value ? "on" : ""}`} role="switch" aria-checked={value} aria-label={label} onClick={() => onChange(!value)}>
    <span className="toggle-knob" />
    <span className="toggle-text">{value ? "On" : "Off"}</span>
  </button>
);
