/**
 * Controls for content placed in areas: placement, timing, look and sound, grouped the way people
 * think about them, plus replace, copy to other areas, stacking order, and a clear route to the
 * shared outline (which is a different thing from this scene's soft-edge adjustment).
 */
import { type RecipeDef, type RecipeInstance, type RecipeParamSpec, resolveTargets, secondsToTime, snapToFrame, timeToSeconds } from "@be/core";
import { type ReactNode, useState } from "react";
import { copyAssignment, isContentDrag, readDragPayload, reorderAssignment, replaceMedia } from "./assign.ts";
import { Field } from "./controls.tsx";
import { activeVenue, useStudio } from "./store.ts";

const GROUPS: Array<{ title: string; keys: string[] }> = [
  { title: "Placement", keys: ["fit", "scale", "offsetX", "offsetY", "rotation", "cropL", "cropR", "cropT", "cropB"] },
  { title: "Timing", keys: ["trim", "speed", "loop", "fadeIn", "fadeOut"] },
  { title: "Look", keys: ["opacity", "blend", "feather", "expansion"] },
  { title: "Sound", keys: ["volume"] },
];

/** Start time and duration of any effect, editable here as well as on the timeline. */
export const TimingFields = ({ inst, def }: { inst: RecipeInstance; def: RecipeDef }) => {
  const project = useStudio((s) => s.project)!;
  const comp = project.compositions[inst.compId];
  const hasSeconds = def.params.some((p) => p.key === "seconds");
  const seconds = Number(inst.params.seconds ?? def.params.find((p) => p.key === "seconds")?.default ?? def.defaultSeconds);
  if (!comp) return null;
  const fps = comp.frameRate.num / comp.frameRate.den;
  return (
    <div className="row gap timing-fields">
      <Field label="Starts at">
        <input
          className="text-input num"
          type="number"
          step={1 / fps}
          min={0}
          value={Number(timeToSeconds(inst.startTime).toFixed(2))}
          aria-label="Starts at (seconds)"
          onChange={(e) => {
            const v = Math.max(0, Number(e.target.value) || 0);
            useStudio.getState().apply({ type: "recipe.update", args: { instanceId: inst.id, startTime: snapToFrame(secondsToTime(v), comp.frameRate) } }, { label: "Change start time", coalesceKey: `${inst.id}:start` });
          }}
        />
      </Field>
      {hasSeconds && (
        <Field label="Lasts">
          <input
            className="text-input num"
            type="number"
            step={0.1}
            min={0.5}
            value={Number(seconds.toFixed(2))}
            aria-label="Duration (seconds)"
            onChange={(e) => useStudio.getState().apply({ type: "recipe.update", args: { instanceId: inst.id, params: { seconds: Math.max(0.5, Number(e.target.value) || 0.5) } } }, { label: "Change duration", coalesceKey: `${inst.id}:seconds` })}
          />
        </Field>
      )}
    </div>
  );
};

const CopyTo = ({ inst }: { inst: RecipeInstance }) => {
  const project = useStudio((s) => s.project)!;
  const venue = activeVenue({ project })!;
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [mode, setMode] = useState<"each" | "across">("each");
  const mine = new Set(resolveTargets(project, inst.targets).map((t) => t.region.id));
  const areas = venue.regionOrder.filter((id) => venue.regions[id]?.path.closed && venue.regions[id]?.kind !== "exclusion" && !mine.has(id));
  if (!open)
    return (
      <button className="ghost" onClick={() => setOpen(true)}>
        Copy to other areas…
      </button>
    );
  const toggle = (ids: string[]) => setChosen((c) => (ids.every((id) => c.includes(id)) ? c.filter((x) => !ids.includes(x)) : [...new Set([...c, ...ids])]));
  return (
    <div className="copy-to" role="group" aria-label="Copy to other areas">
      <strong className="small">Copy “{inst.label}” to:</strong>
      {Object.values(venue.groups).map((g) => (
        <label key={g.id} className="check">
          <input type="checkbox" checked={g.regionIds.every((id) => chosen.includes(id))} onChange={() => toggle(g.regionIds.filter((id) => !mine.has(id)))} /> {g.name} (group)
        </label>
      ))}
      <div className="copy-areas">
        {areas.map((id) => (
          <label key={id} className="check">
            <input type="checkbox" checked={chosen.includes(id)} onChange={() => toggle([id])} /> {venue.regions[id]!.name}
          </label>
        ))}
      </div>
      {inst.recipeId === "area-content" && chosen.length > 1 && (
        <div className="segmented" role="radiogroup" aria-label="Repeat or span">
          <button role="radio" aria-checked={mode === "each"} className={mode === "each" ? "on" : ""} onClick={() => setMode("each")}>
            Repeat in each
          </button>
          <button role="radio" aria-checked={mode === "across"} className={mode === "across" ? "on" : ""} onClick={() => setMode("across")}>
            Span across
          </button>
        </div>
      )}
      <div className="row gap">
        <button
          className="primary"
          disabled={!chosen.length}
          onClick={() => {
            const id = copyAssignment(inst.id, chosen, inst.recipeId === "area-content" ? mode : undefined);
            setOpen(false);
            setChosen([]);
            if (id) useStudio.getState().toast({ kind: "success", text: `Copied to ${chosen.length} area${chosen.length > 1 ? "s" : ""}. Each copy can be adjusted on its own.` });
          }}
        >
          Copy
        </button>
        <button className="ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
};

export const AssignmentControls = ({
  inst,
  def,
  params,
  render,
}: {
  inst: RecipeInstance;
  def: RecipeDef;
  params: Record<string, unknown>;
  render: (spec: RecipeParamSpec) => ReactNode;
}) => {
  const [open, setOpen] = useState<Record<string, boolean>>({ Placement: true, Timing: false, Look: false, Sound: false });
  const [over, setOver] = useState(false);
  const project = useStudio((s) => s.project)!;
  const asset = typeof params.assetId === "string" ? project.assets[params.assetId] : undefined;
  const byKey = new Map(def.params.map((p) => [p.key, p]));
  const targets = resolveTargets(project, inst.targets);
  return (
    <>
      <div
        className={`replace-zone ${over ? "over" : ""}`}
        onDragOver={(e) => {
          if (!isContentDrag(e.dataTransfer)) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false);
          const p = readDragPayload(e.dataTransfer);
          if (p?.kind === "asset") {
            e.preventDefault();
            replaceMedia(inst.id, p.id);
          }
        }}
      >
        {render(byKey.get("assetId")!)}
        <span className="muted small">Drop another picture or video here to replace it — placement and timing stay.</span>
      </div>
      {render(byKey.get("mode")!)}
      {params.mode === "across" && targets.length > 1 && <p className="muted small">One continuous picture across {targets.length} areas.</p>}
      {asset?.kind === "image" && <p className="muted small">A still picture: speed, looping and sound don't apply.</p>}
      {GROUPS.map((g) => (
        <section key={g.title} className="param-group">
          <button className="disclosure" aria-expanded={!!open[g.title]} onClick={() => setOpen((o) => ({ ...o, [g.title]: !o[g.title] }))}>
            {g.title}
          </button>
          {open[g.title] && g.keys.map((k) => byKey.get(k)).filter((p): p is RecipeParamSpec => !!p).map((p) => <div key={p.key}>{render(p)}</div>)}
        </section>
      ))}
      <div className="row gap wrap">
        <CopyTo inst={inst} />
        <button className="icon" title="Bring forward" aria-label="Bring forward" onClick={() => reorderAssignment(inst.id, -1)}>
          ↑
        </button>
        <button className="icon" title="Send backward" aria-label="Send backward" onClick={() => reorderAssignment(inst.id, 1)}>
          ↓
        </button>
      </div>
      <div className="shared-note" role="note">
        “Soften edge (this scene)” only changes this content. To reshape the area itself — in every scene —{" "}
        <button
          className="link small"
          onClick={() => {
            useStudio.setState({ step: "space" });
            useStudio.getState().selectRegions(targets.map((t) => t.region.id));
          }}
        >
          edit the shared outline
        </button>
        .
      </div>
    </>
  );
};
