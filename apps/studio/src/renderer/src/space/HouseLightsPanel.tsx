/**
 * House lights panel: the flames on the building (candles at its foot, a torch in a lantern) — part of
 * the house setup, lighting every 3D scene of the show and the candlelight layer. Each light's place
 * (where its flame shows, and how far in front of the building), colour, brightness, reach, shadows and
 * flicker are adjustable here; brightness over the show is keyframed (house.setLights).
 */
import { HOUSE_LIGHT_DEFAULTS, type HouseLight, staticProp } from "@be/core";
import { ColorField, Field, Slider, Toggle } from "../studio/controls.tsx";
import { activeVenue, useStudio } from "../studio/store.ts";

const setLights = (venueId: string, lights: HouseLight[], label: string, key?: string) =>
  useStudio.getState().apply({ type: "venue.update", args: { venueId, changes: { lights } } }, { label, ...(key ? { coalesceKey: key } : {}) });

export const HouseLightsPanel = () => {
  const project = useStudio((s) => s.project);
  const venue = project ? activeVenue({ project }) : undefined;
  if (!venue) return null;
  const lights = venue.lights ?? [];
  const change = (i: number, patch: Partial<HouseLight>, label: string, key: string) =>
    setLights(venue.id, lights.map((L, j) => (j === i ? { ...L, ...patch } : L)), label, `house-light:${lights[i]!.id}:${key}`);
  const add = () => {
    const n = lights.length + 1;
    const L: HouseLight = { id: `hl_${Date.now().toString(36)}`, name: `Candle ${n}`, at: [venue.canvas.width / 2, venue.canvas.height * 0.8], depth: 0.2, intensity: staticProp(1), ...HOUSE_LIGHT_DEFAULTS, flicker: { ...HOUSE_LIGHT_DEFAULTS.flicker, seed: n * 101 } };
    setLights(venue.id, [...lights, L], "Add a house light");
  };
  return (
    <div className="house-lights" role="region" aria-label="House lights">
      <div className="row gap">
        <strong>House lights</strong>
        <button className="ghost" onClick={add}>
          + Light
        </button>
      </div>
      <p className="small">The flames on the building — candles, torches. They light every 3D scene of the show and the candlelight layer, cast shadows from the house's walls, columns and roof edges, and flicker by show time (continuous from scene to scene).</p>
      {lights.map((L, i) => (
        <details key={L.id} className="house-light">
          <summary>
            {L.name} <span className="small">({L.intensity.keyframes?.length ? "changes over the show" : `brightness ${L.intensity.value}`})</span>
          </summary>
          <Field label="Name">
            <input value={L.name} aria-label="House light name" onChange={(e) => change(i, { name: e.target.value || L.name }, "Rename house light", "name")} />
          </Field>
          <Field label="Flame on the canvas" help="Where its flame shows in the picture (pixels).">
            <Slider label="Flame x" value={L.at[0]} min={0} max={venue.canvas.width} step={1} unit="px" onChange={(v) => change(i, { at: [v, L.at[1]] }, "Move house light", "at")} />
            <Slider label="Flame y" value={L.at[1]} min={0} max={venue.canvas.height} step={1} unit="px" onChange={(v) => change(i, { at: [L.at[0], v] }, "Move house light", "at")} />
          </Field>
          <Field label="In front of the building" help="Metres in front of the building's front; negative: set back into it (a recessed window sill).">
            <Slider label="Depth" value={L.depth} min={-5} max={5} step={0.01} unit="m" onChange={(v) => change(i, { depth: v }, "Move house light", "depth")} />
          </Field>
          <Field label="Colour">
            <ColorField label="Flame colour" value={L.color} onChange={(c) => change(i, { color: c }, "Change house light colour", "color")} />
          </Field>
          {!L.intensity.keyframes?.length && (
            <Field label="Brightness">
              <Slider label="Brightness" value={L.intensity.value} min={0} max={20} step={0.05} onChange={(v) => change(i, { intensity: staticProp(v) }, "Change house light brightness", "intensity")} />
            </Field>
          )}
          <Field label="Reach" help="Metres beyond which it lights nothing (0: no limit), and how fast it weakens (2 as real light).">
            <Slider label="Range" value={L.range} min={0} max={30} step={0.1} unit="m" onChange={(v) => change(i, { range: v }, "Change house light reach", "range")} />
            <Slider label="Falloff" value={L.falloff} min={0} max={4} step={0.1} onChange={(v) => change(i, { falloff: v }, "Change house light falloff", "falloff")} />
          </Field>
          <Field label="Shadows" help="The house's solids cast shadows from it.">
            <Toggle label="Casts shadows" value={L.castShadow} onChange={(v) => change(i, { castShadow: v }, v ? "House light casts shadows" : "House light casts no shadows", "shadow")} />
            <Slider label="Shadow softness" value={L.softness} min={0} max={1} step={0.05} onChange={(v) => change(i, { softness: v }, "Change house light shadow softness", "softness")} />
          </Field>
          <Field label="Flicker" help="Its brightness × (1 + wiggle(speed, amount, octaves, seed)) by show time — the same wiggle a flame layer uses, so they can flicker together.">
            <Slider label="Flicker amount" value={L.flicker.amount} min={0} max={1} step={0.01} onChange={(v) => change(i, { flicker: { ...L.flicker, amount: v } }, "Change house light flicker", "flicker")} />
            <Slider label="Flicker speed" value={L.flicker.speed} min={0} max={30} step={0.1} unit="/s" onChange={(v) => change(i, { flicker: { ...L.flicker, speed: v } }, "Change house light flicker", "flicker")} />
            <Slider label="Flicker seed" value={L.flicker.seed} min={0} max={9999} step={1} onChange={(v) => change(i, { flicker: { ...L.flicker, seed: v } }, "Change house light flicker", "flicker")} />
            <Slider label="Flicker detail" value={L.flicker.octaves} min={1} max={6} step={1} onChange={(v) => change(i, { flicker: { ...L.flicker, octaves: v } }, "Change house light flicker", "flicker")} />
          </Field>
          <button className="ghost danger" onClick={() => setLights(venue.id, lights.filter((_, j) => j !== i), "Remove a house light")}>
            Remove this light
          </button>
        </details>
      ))}
    </div>
  );
};
