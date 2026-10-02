/** Contextual inspector: only what the current selection needs, simple controls first. */
import {
  defaultParams,
  getRecipe,
  homographyResiduals,
  isConvexQuad,
  overriddenParams,
  type Project,
  type RecipeInstance,
  resolveTargets,
  type RecipeParamSpec,
  solveHomography,
  timeToSeconds,
  type Vec2,
} from "@be/core";
import { useState } from "react";
import { applyEffect, applyRecipeToSelection, KIND_LABEL, previewRecipe, suggestedRecipes } from "./actions.ts";
import { Choice, ColorField, Field, Slider, Toggle } from "./controls.tsx";
import { usePreview } from "../preview/settings.ts";
import { deleteRegions, suggestSimilar } from "../space/actions.ts";
import { clearHoles } from "../space/areaEdit.ts";
import { KIND_CHOICES } from "../space/traceStore.ts";
import { FONTS, LayerPanel } from "./LayerPanel.tsx";
import { analyseBeats, importMediaFiles } from "./media.ts";
import { ProjectorOutputPanel } from "./ProjectorOutputPanel.tsx";
import { simProgress, useSims } from "./simHost.ts";
import { contentForArea, reorderAssignment } from "./assign.ts";
import { AssignmentControls, TimingFields } from "./AssignmentPanel.tsx";
import { makeArea3D } from "./actions3d.ts";
import { Scene3DPanel } from "./Scene3DPanel.tsx";

/** Make the selected areas 3D: a solid with thickness, or one that collapses and rebuilds. */
const Make3D = ({ ids }: { ids: readonly string[] }) => (
  <div className="make-3d">
    <h3 className="subhead">3D</h3>
    <div className="row gap wrap">
      <button className="ghost" onClick={() => makeArea3D(ids, false)} title="A solid slab the shape of the area, with the building photo on its front">
        Give it thickness (3D)
      </button>
      <button className="ghost" onClick={() => makeArea3D(ids, true)} title="The area breaks into pieces that fall with real physics, then fly back">
        Collapse &amp; rebuild (3D)
      </button>
    </div>
  </div>
);
import { activeVenue, currentComp, useStudio } from "./store.ts";

export const Inspector = () => {
  const view = usePreview((s) => s.view);
  const step = useStudio((s) => s.step);
  const selection = useStudio((s) => s.selection);
  const project = useStudio((s) => s.project);
  if (!project) return null;
  return (
    <aside className="panel inspector" aria-label="Inspector">
      {view === "projector" ? (
        <CalibrationPanel />
      ) : selection.layerId && currentComp(useStudio.getState())?.layers[selection.layerId]?.source.kind === "scene3d" ? (
        <Scene3DPanel layer={currentComp(useStudio.getState())!.layers[selection.layerId]!} />
      ) : selection.layerId && currentComp(useStudio.getState())?.layers[selection.layerId] ? (
        <LayerPanel layer={currentComp(useStudio.getState())!.layers[selection.layerId]!} />
      ) : step === "space" && selection.regionIds.length ? (
        <RegionEditPanel />
      ) : selection.recipeId && project.recipes[selection.recipeId] ? (
        <RecipePanel inst={project.recipes[selection.recipeId]!} />
      ) : selection.regionIds.length ? (
        <RegionPanel />
      ) : (
        <ShowPanel />
      )}
    </aside>
  );
};

/** The parts an effect is on, by name ("Window 5, Window 6"), not by internal role. */
const describeTargets = (project: Project, inst: RecipeInstance): string => {
  const names = resolveTargets(project, inst.targets).map((t) => t.region.name);
  if (!names.length) return "no parts (they were removed)";
  return names.length > 4 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
};

/** Simulation progress for an effect's layers: preparing (with progress) or ready. */
const SimStatusLine = ({ layerIds }: { layerIds: readonly string[] }) => {
  const status = useSims((s) => s.status);
  const p = simProgress(status, layerIds);
  if (!p) return null;
  if (p.done >= p.total) return <p className="ok-text small">✓ Simulation prepared ({p.total} frames). Changing a setting prepares it again.</p>;
  return (
    <div className="sim-status">
      <span className="small">
        Preparing the simulation… {p.done} of {p.total} frames. It plays as far as it's prepared.
      </span>
      <progress max={p.total} value={p.done} />
    </div>
  );
};

const RecipePanel = ({ inst }: { inst: RecipeInstance }) => {
  const def = getRecipe(inst.recipeId);
  const [more, setMore] = useState(false);
  const [structure, setStructure] = useState(false);
  const project = useStudio((s) => s.project)!;
  if (!def) return <p className="muted">This effect needs a newer version of Before Effects.</p>;
  const params = { ...defaultParams(def), ...inst.params };
  const customized = new Set(overriddenParams(def, inst));
  const set = (key: string, value: unknown) =>
    useStudio.getState().apply({ type: "recipe.update", args: { instanceId: inst.id, params: { [key]: value } } }, { label: `Adjust ${def.title}`, coalesceKey: `${inst.id}:${key}` });
  const primary = def.params.filter((p) => p.primary);
  const rest = def.params.filter((p) => !p.primary);
  const comp = project.compositions[inst.compId];
  const layers = Object.values(inst.generated).map((id) => comp?.layers[id]).filter((l): l is NonNullable<typeof l> => !!l);

  return (
    <div className="inspector-body">
      <div className="panel-head">
        <h2>{inst.label}</h2>
      </div>
      <p className="muted small">On {describeTargets(project, inst)} · starts at {timeToSeconds(inst.startTime).toFixed(1)} s</p>
      <SimStatusLine layerIds={Object.values(inst.generated)} />
      <TimingFields inst={inst} def={def} />
      {def.id === "area-content" ? (
        <AssignmentControls inst={inst} def={def} params={params} render={(p) => <ParamControl key={p.key} spec={p} value={params[p.key]} onChange={(v) => set(p.key, v)} customized={customized.has(p.key)} instId={inst.id} />} />
      ) : (
        <>
          {primary.filter((p) => p.key !== "seconds").map((p) => (
            <ParamControl key={p.key} spec={p} value={params[p.key]} onChange={(v) => set(p.key, v)} customized={customized.has(p.key)} instId={inst.id} />
          ))}
          {rest.filter((p) => p.key !== "seconds").length > 0 && (
            <button className="disclosure" aria-expanded={more} onClick={() => setMore(!more)}>
              {more ? "Fewer controls" : `More controls (${rest.filter((p) => p.key !== "seconds").length})`}
            </button>
          )}
          {more && rest.filter((p) => p.key !== "seconds").map((p) => <ParamControl key={p.key} spec={p} value={params[p.key]} onChange={(v) => set(p.key, v)} customized={customized.has(p.key)} instId={inst.id} />)}
        </>
      )}

      <button className="disclosure" aria-expanded={structure} onClick={() => setStructure(!structure)}>
        {structure ? "Hide animation details" : "Edit animation"}
      </button>
      {structure && (
        <div className="structure">
          <p className="muted small">This effect is made of ordinary layers you can inspect. Hand edits are kept even when you change the controls above.</p>
          {layers.map((l) => {
            const contents = l.source.kind === "shape" ? l.source.contents : [];
            const keyed = contents.reduce((n, c) => n + [c.fill?.opacity, c.stroke?.opacity, c.trim?.start, c.trim?.end, c.trim?.offset].filter((x) => x?.keyframes?.length).length, 0);
            return (
              <div key={l.id} className="structure-layer">
                <strong>{l.name}</strong>
                <span className="muted small">
                  Shape layer · {contents.length} path{contents.length === 1 ? "" : "s"} following the building · {keyed} animated propert{keyed === 1 ? "y" : "ies"} · effects: {l.effects.map((e) => e.type).join(", ") || "none"} · blend: {l.blendMode}
                </span>
              </div>
            );
          })}
          <p className="muted small">Keyframe and curve editing open with the graph editor in milestone C.</p>
        </div>
      )}

      <div className="row gap">
        <button
          className="danger-ghost"
          onClick={() => {
            useStudio.getState().apply({ type: "recipe.remove", args: { instanceId: inst.id } }, { label: `Remove ${def.title}` });
            useStudio.getState().selectRecipe(null);
          }}
        >
          Remove effect
        </button>
        <button
          className="ghost"
          title="Keep the layers but drop the simple controls"
          onClick={() => {
            useStudio.getState().apply({ type: "recipe.detach", args: { instanceId: inst.id } }, { label: "Convert to regular layers" });
            useStudio.getState().selectRecipe(null);
          }}
        >
          Convert to layers
        </button>
      </div>
    </div>
  );
};

const ParamControl = ({ spec, value, onChange, customized, instId }: { spec: RecipeParamSpec; value: unknown; onChange: (v: unknown) => void; customized: boolean; instId: string }) => {
  const badge = customized ? (
    <span className="badge" title="You edited part of this by hand. This control won't override your edit.">
      Customized ·{" "}
      <button className="link" onClick={() => useStudio.getState().apply({ type: "recipe.resetOverrides", args: { instanceId: instId, paths: spec.drives ?? [] } }, { label: "Reset to effect settings" })}>
        reset
      </button>
    </span>
  ) : undefined;
  let control;
  switch (spec.control) {
    case "color":
      control = <ColorField value={(value as number[]) ?? [1, 1, 1, 1]} onChange={onChange} label={spec.label} />;
      break;
    case "choice":
      control = <Choice value={String(value)} choices={spec.choices ?? []} onChange={onChange} label={spec.label} />;
      break;
    case "toggle":
      control = <Toggle value={value !== false} onChange={onChange} label={spec.label} />;
      break;
    case "media": {
      const project = useStudio.getState().project!;
      const kinds = spec.accepts ?? ["image", "video"];
      const options = Object.values(project.assets).filter((a) => (kinds as readonly string[]).includes(a.kind) || (kinds.includes("audio") && !!a.audioPath));
      control = (
        <div className="row gap wrap">
          <select className="select" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} aria-label={spec.label}>
            <option value="">Choose…</option>
            {options.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.analysis ? ` · ${Math.round(a.analysis.bpm)} BPM` : ""}
              </option>
            ))}
          </select>
          <button
            className="ghost small-btn"
            onClick={async () => {
              const added = await importMediaFiles();
              const pick = added.find((a) => (kinds as readonly string[]).includes(a.kind));
              if (pick) {
                if (pick.kind === "audio") await analyseBeats(pick);
                onChange(pick.id);
              }
            }}
          >
            Import…
          </button>
        </div>
      );
      break;
    }
    case "text":
      control = <textarea className="text-input" rows={2} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} aria-label={spec.label} />;
      break;
    case "font":
      control = (
        <select className="select" value={String(value ?? "Segoe UI")} onChange={(e) => onChange(e.target.value)} aria-label={spec.label}>
          {[...new Set([String(value ?? "Segoe UI"), ...FONTS])].map((f) => (
            <option key={f} value={f} style={{ fontFamily: f }}>
              {f}
            </option>
          ))}
        </select>
      );
      break;
    case "seed":
      control = (
        <button className="ghost" onClick={() => onChange(((value as number) ?? 1) + 1)}>
          Shuffle
        </button>
      );
      break;
    default:
      control = <Slider value={Number(value ?? spec.default)} min={spec.min ?? 0} max={spec.max ?? 100} step={spec.step ?? (spec.control === "seconds" ? 0.1 : 1)} unit={spec.unit} onChange={onChange} label={spec.label} />;
  }
  return (
    <Field label={spec.label} help={spec.help} badge={badge}>
      {control}
    </Field>
  );
};

const RegionPanel = () => {
  const project = useStudio((s) => s.project)!;
  const ids = useStudio((s) => s.selection.regionIds);
  const venue = activeVenue({ project })!;
  const regs = ids.map((id) => venue.regions[id]).filter((r): r is NonNullable<typeof r> => !!r);
  const suggestions = suggestedRecipes(project, ids);
  useStudio((s) => s.version);
  // What this scene puts in these areas (top-most first); other scenes are unaffected.
  const onThese = [...new Map(ids.flatMap((id) => contentForArea(id)).map((r) => [r.id, r])).values()];
  const scene = currentComp(useStudio.getState());
  const kind = regs[0]?.kind ?? "custom";
  return (
    <div className="inspector-body">
      <div className="panel-head">
        <h2>{regs.length === 1 ? regs[0]!.name : `${regs.length} ${KIND_LABEL[kind][1]}`}</h2>
      </div>
      <p className="muted small">Choose what should happen here:</p>
      <div className="suggest-list">
        {suggestions.map((r) => (
          <button key={r.id} className="suggest" onClick={() => void applyEffect(r.id)} onPointerEnter={() => previewRecipe(r.id)} onPointerLeave={() => previewRecipe(null)}>
            <strong>{r.title}</strong>
            <span className="muted small">{r.description}</span>
          </button>
        ))}
      </div>
      <Make3D ids={ids} />
      <h3 className="subhead">In this scene{scene ? ` (${scene.name})` : ""}</h3>
      {onThese.length === 0 && <p className="muted small">Nothing yet. Drag a picture, video or animation onto the area.</p>}
      {onThese.map((r, i) => (
        <div key={r.id} className="stack-row">
          <button className="list-item grow" onClick={() => useStudio.getState().selectRecipe(r.id)}>
            {r.label}
          </button>
          <button className="icon small" disabled={i === 0} aria-label={`Bring ${r.label} forward`} title="Bring forward" onClick={() => reorderAssignment(r.id, -1)}>
            ↑
          </button>
          <button className="icon small" disabled={i === onThese.length - 1} aria-label={`Send ${r.label} backward`} title="Send backward" onClick={() => reorderAssignment(r.id, 1)}>
            ↓
          </button>
        </div>
      ))}
      <div className="shared-note" role="note">
        The outline is shared by every scene.{" "}
        <button className="link small" onClick={() => useStudio.setState({ step: "space" })}>
          Edit the shared outline…
        </button>
      </div>
      <p className="muted small tip">Tip: Shift-click to select several areas. Esc clears the selection.</p>
    </div>
  );
};

const ShowPanel = () => {
  const project = useStudio((s) => s.project)!;
  const comp = currentComp(useStudio.getState());
  const recipes = Object.values(project.recipes);
  return (
    <div className="inspector-body">
      <div className="panel-head">
        <h2>Your show</h2>
      </div>
      {comp && (
        <p className="muted small">
          {comp.width}×{comp.height} · {Math.round((comp.frameRate.num / comp.frameRate.den) * 100) / 100} fps · {timeToSeconds(comp.duration).toFixed(0)} s long
        </p>
      )}
      <h3 className="subhead">Effects ({recipes.length})</h3>
      {recipes.length === 0 && <p className="muted small">Nothing yet. Click a window, door or roofline on the building to start.</p>}
      {recipes.map((r) => (
        <button key={r.id} className="list-item" onClick={() => useStudio.getState().selectRecipe(r.id)}>
          {r.label} <span className="muted small">· {describeTargets(project, r)}</span>
        </button>
      ))}
      <p className="muted small tip">Click any part of the building to see what you can do with it.</p>
    </div>
  );
};

const CalibrationPanel = () => {
  const project = useStudio((s) => s.project)!;
  const showGrid = useStudio((s) => s.showGrid);
  const venue = activeVenue({ project });
  const projector = venue?.projectorOrder[0] ? venue.projectors[venue.projectorOrder[0]] : undefined;
  if (!venue || !projector) return <p className="muted">No projector yet.</p>;
  const cal = projector.calibration;
  const src = cal.points.map((p) => p.content as Vec2);
  const dst = cal.points.map((p) => p.output as Vec2);
  const H = solveHomography(src, dst);
  const residuals = H ? homographyResiduals(H, src, dst) : [];
  const folded = cal.points.length === 4 && !isConvexQuad(dst);
  const apply = useStudio.getState().apply;
  return (
    <div className="inspector-body">
      <div className="panel-head">
        <h2>Line up {projector.name}</h2>
      </div>
      <ol className="steps">
        <li>Open the projector output below, on the display connected to the projector.</li>
        <li>Drag each numbered point until it sits on the matching corner of the building: 1 top-left, 2 top-right, 3 bottom-right, 4 bottom-left.</li>
        <li>Turn on the grid to check straight lines, then lock the alignment.</li>
      </ol>
      {folded && <p className="warn">The shape is folded over itself — two points are probably swapped.</p>}
      {!H && <p className="warn">These points can't be solved. Move them apart so no three are in a line.</p>}
      {residuals.length > 4 && <p className="muted small">Largest alignment error: {Math.max(...residuals).toFixed(1)} px</p>}
      <Field label="Alignment grid">
        <Toggle value={showGrid} onChange={(v) => useStudio.getState().setShowGrid(v)} label="Alignment grid" />
      </Field>
      <Field label="Lock alignment" help="Locked alignment can't be changed by accident while you work on the show.">
        <Toggle value={cal.locked} onChange={(v) => apply({ type: "calibration.lock", args: { venueId: venue.id, projectorId: projector.id, locked: v } })} label="Lock alignment" />
      </Field>
      <div className="row gap">
        <button className="ghost" onClick={() => apply({ type: "calibration.save", args: { venueId: venue.id, projectorId: projector.id, savedAt: new Date().toISOString() } })}>
          Save this alignment
        </button>
      </div>
      {projector.calibrationHistory.length > 0 && (
        <>
          <h3 className="subhead">Saved alignments</h3>
          {projector.calibrationHistory
            .slice()
            .reverse()
            .map((c) => (
              <button key={c.version} className="list-item" onClick={() => apply({ type: "calibration.restore", args: { venueId: venue.id, projectorId: projector.id, version: c.version } })}>
                Version {c.version} · {c.savedAt ? new Date(c.savedAt).toLocaleString() : ""} — restore
              </button>
            ))}
        </>
      )}
      <ProjectorOutputPanel venueId={venue.id} projectorId={projector.id} />
      <p className="muted small tip">This preview shows what the projector will output. It can't show how it looks on the real wall — check that in person. Physical alignment is reported as unverified until it has been checked with real hardware.</p>
    </div>
  );
};

/** Space step: name, classify, correct and remove traced parts. */
const RegionEditPanel = () => {
  const project = useStudio((s) => s.project)!;
  const ids = useStudio((s) => s.selection.regionIds);
  const venue = activeVenue({ project })!;
  const regs = ids.map((id) => venue.regions[id]).filter((r): r is NonNullable<typeof r> => !!r);
  if (regs.length === 0) return null;
  const one = regs.length === 1 ? regs[0]! : null;
  const apply = useStudio.getState().apply;
  return (
    <div className="inspector-body">
      <div className="panel-head">
        <h2>{one ? one.name : `${regs.length} parts`}</h2>
      </div>
      {one && (
        <Field label="Name">
          <input
            className="text-input"
            value={one.name}
            onChange={(e) => apply({ type: "region.update", args: { venueId: venue.id, regionId: one.id, changes: { name: e.target.value || one.name } } }, { label: "Rename part", coalesceKey: `name-${one.id}` })}
            aria-label="Part name"
          />
        </Field>
      )}
      <Make3D ids={ids} />
      <Field label="What is it?">
        <select
          className="select"
          value={regs.every((r) => r.kind === regs[0]!.kind) ? regs[0]!.kind : ""}
          onChange={(e) =>
            apply(
              regs.map((r) => ({ type: "region.update", args: { venueId: venue.id, regionId: r.id, changes: { kind: e.target.value } } })),
              { label: "Change part type" },
            )
          }
          aria-label="Part type"
        >
          {!regs.every((r) => r.kind === regs[0]!.kind) && <option value="">Mixed</option>}
          {KIND_CHOICES.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </select>
      </Field>
      {one && <p className="muted small">{one.path.vertices.length} corners · drag the corner squares on the photo to correct the outline.</p>}
      {one && one.path.closed && (
        <div className="shared-note" role="note">
          <strong>Shared by every scene.</strong> These settings change this area wherever it's used. To soften content in one scene only, use “Soften edge (this scene)” on that content instead.
        </div>
      )}
      {one && one.path.closed && (
        <>
          <Field label="Soft edge" help="How softly content fades out at the area's edge, in every scene.">
            <Slider label="Soft edge" min={0} max={80} unit="px" value={one.feather ?? 0} onChange={(v) => apply({ type: "region.update", args: { venueId: venue.id, regionId: one.id, changes: { feather: v } } }, { label: "Soften area edge", coalesceKey: `feather-${one.id}` })} />
          </Field>
          <Field label="Grow / shrink edge" help="Push the edge out (+) or pull it in (−), in every scene.">
            <Slider label="Grow or shrink edge" min={-40} max={40} unit="px" value={one.expansion ?? 0} onChange={(v) => apply({ type: "region.update", args: { venueId: venue.id, regionId: one.id, changes: { expansion: v } } }, { label: "Grow/shrink area edge", coalesceKey: `expand-${one.id}` })} />
          </Field>
          <p className="muted small">
            {one.holes?.length ? `${one.holes.length} hole${one.holes.length > 1 ? "s" : ""} cut out. ` : "No holes. "}Use “Cut a hole” on the left to cut one (e.g. a window out of a wall).
            {one.holes?.length ? (
              <>
                {" "}
                <button className="link small" onClick={() => clearHoles(one)}>
                  Remove holes
                </button>
              </>
            ) : null}
          </p>
        </>
      )}
      <div className="row gap wrap">
        {one && (one.kind === "window" || one.kind === "door" || one.kind === "garage" || one.kind === "column" || one.kind === "vent" || one.kind === "light") && (
          <button className="ghost" onClick={() => void suggestSimilar(one.id)}>
            Find similar
          </button>
        )}
        <button className="danger-ghost" onClick={() => deleteRegions(ids)}>
          Remove {regs.length > 1 ? `${regs.length} areas` : "area"}
        </button>
      </div>
      <p className="muted small tip">Content and effects follow these outlines in every scene. If you correct an outline, everything on it updates too.</p>
    </div>
  );
};
