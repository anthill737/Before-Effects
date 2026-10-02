/**
 * How a moving part moves: the kind of motion and its settings, its timing, and what shows behind
 * its opening. Every change rebuilds the part's keyframes (one undo step; slider drags coalesce).
 */
import { ASSUMED_DEPTH, type Backing, type Object3D, type PartMotion, partDepth } from "@be/core";
import { Choice, ColorField, Field, Slider, Toggle } from "./controls.tsx";
import { MOVES, removePart, secondsLabel, updatePart, wallColorAround } from "./parts.ts";
import { activeVenue, useStudio } from "./store.ts";

const FRESH: Record<PartMotion["kind"], PartMotion> = {
  swing: { kind: "swing", hinge: "left", direction: "in", angle: 95 },
  raise: { kind: "raise", style: "slide" },
  push: { kind: "push", distance: -0.25 },
  slide: { kind: "slide", direction: "left" },
  turn: { kind: "turn", axis: "vertical", turns: 1 },
  fall: { kind: "fall" },
};

export const PartEditor = ({ o }: { o: Object3D }) => {
  const project = useStudio((s) => s.project)!;
  const info = o.part!;
  const venue = activeVenue({ project });
  const region = venue?.regions[info.regionId];
  const m = info.motion;
  const t = info.timing;
  const set = (changes: Parameters<typeof updatePart>[1], key: string) => updatePart(o.id, changes, key);
  const setMotion = (c: Partial<PartMotion>, key: string) => set({ motion: { ...m, ...c } as PartMotion }, key);
  const images = Object.values(project.assets).filter((a) => a.kind === "image" && a.purpose !== "venue-reference" && a.id !== venue?.photo?.assetId);
  const setBacking = async (kind: Backing["kind"]) => {
    if (kind === "recess") set({ backing: { kind: "recess" } }, "backing");
    else if (kind === "room") set({ backing: { kind: "room", color: [1, 0.78, 0.45, 1] } }, "backing");
    else if (kind === "wall") set({ backing: { kind: "wall", color: await wallColorAround(info.regionId) } }, "backing");
    else if (images[0]) set({ backing: { kind: "image", assetId: images[0].id } }, "backing");
    else useStudio.getState().toast({ kind: "info", text: "Import a picture first (Content step), then choose it here." });
  };
  return (
    <section className="param-group part-editor" aria-label={`How ${o.name} moves`}>
      <h3 className="subhead">How it moves</h3>
      <p className="muted small">
        Made from the area “{region?.name ?? "?"}” — the traced area itself never moves. {secondsLabel(t)}.
      </p>
      <Field label="Motion">
        <Choice label="Motion" value={m.kind} choices={(Object.keys(MOVES) as PartMotion["kind"][]).map((k) => ({ value: k, label: MOVES[k] }))} onChange={(v) => set({ motion: FRESH[v as PartMotion["kind"]] }, "motion")} />
      </Field>
      {m.kind === "swing" && (
        <>
          <Field label="Hinge">
            <Choice label="Hinge" value={m.hinge} choices={[{ value: "left", label: "Left side" }, { value: "right", label: "Right side" }]} onChange={(v) => setMotion({ hinge: v as "left" | "right" }, "hinge")} />
          </Field>
          <Field label="Opens">
            <Choice label="Opens" value={m.direction} choices={[{ value: "in", label: "Into the house" }, { value: "out", label: "Toward the audience" }]} onChange={(v) => setMotion({ direction: v as "in" | "out" }, "dir")} />
          </Field>
          <Field label="How far">
            <Slider label="Opening angle" value={m.angle} min={10} max={170} step={1} unit="°" onChange={(v) => setMotion({ angle: v }, "angle")} />
          </Field>
        </>
      )}
      {m.kind === "raise" && (
        <Field label="Style">
          <Choice label="Raise style" value={m.style} choices={[{ value: "slide", label: "Slides up behind the wall" }, { value: "tilt", label: "Tips up and back" }]} onChange={(v) => setMotion({ style: v as "slide" | "tilt" }, "style")} />
        </Field>
      )}
      {m.kind === "push" && (
        <Field label="Distance" help="Negative pushes into the house; positive pulls out toward the audience.">
          <Slider label="Push distance" value={Math.round(m.distance * 100)} min={-150} max={150} step={1} unit="cm" onChange={(v) => setMotion({ distance: v / 100 }, "dist")} />
        </Field>
      )}
      {m.kind === "slide" && (
        <Field label="Direction">
          <Choice label="Slide direction" value={m.direction} choices={[{ value: "left", label: "Left" }, { value: "right", label: "Right" }, { value: "up", label: "Up" }, { value: "down", label: "Down" }]} onChange={(v) => setMotion({ direction: v as "left" | "right" | "up" | "down" }, "sdir")} />
        </Field>
      )}
      {m.kind === "turn" && (
        <>
          <Field label="Axis">
            <Choice label="Turn axis" value={m.axis} choices={[{ value: "vertical", label: "Spin (vertical axis)" }, { value: "horizontal", label: "Flip (horizontal axis)" }]} onChange={(v) => setMotion({ axis: v as "vertical" | "horizontal" }, "axis")} />
          </Field>
          <Field label="Turns">
            <Slider label="Turns" value={m.turns} min={0.25} max={4} step={0.25} onChange={(v) => setMotion({ turns: v }, "turns")} />
          </Field>
        </>
      )}
      {m.kind === "fall" && <p className="muted small">Comes loose and falls with real physics (prepared ahead, like collapses).</p>}

      <Field label="Starts at" help="Seconds into the scene.">
        <Slider label="Starts at" value={t.start} min={0} max={60} step={0.1} unit="s" onChange={(v) => set({ timing: { start: v } }, "start")} />
      </Field>
      <Field label="Takes">
        <Slider label="Move takes" value={t.move} min={0.2} max={10} step={0.1} unit="s" onChange={(v) => set({ timing: { move: v } }, "move")} />
      </Field>
      <Field label="Goes back">
        <Toggle label="Goes back" value={t.back} onChange={(v) => set({ timing: { back: v } }, "back")} />
      </Field>
      {t.back && (
        <Field label="Stays moved for">
          <Slider label="Stays moved for" value={t.hold} min={0} max={30} step={0.1} unit="s" onChange={(v) => set({ timing: { hold: v } }, "hold")} />
        </Field>
      )}

      <Field label="Behind the opening">
        <Choice
          label="Behind the opening"
          value={info.backing.kind}
          choices={[
            { value: "recess", label: "Dark recess" },
            { value: "room", label: "Lit room" },
            { value: "image", label: "A picture" },
            { value: "wall", label: "Wall colour" },
          ]}
          onChange={(v) => void setBacking(v as Backing["kind"])}
        />
      </Field>
      {info.backing.kind === "room" && (
        <Field label="Room light">
          <ColorField label="Room light colour" value={info.backing.color} onChange={(c) => set({ backing: { kind: "room", color: c } }, "room")} />
        </Field>
      )}
      {info.backing.kind === "image" && (
        <Field label="Picture">
          <select className="select" aria-label="Picture behind the opening" value={info.backing.assetId} onChange={(e) => set({ backing: { kind: "image", assetId: e.target.value } }, "img")}>
            {images.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <p className="muted small" role="note">
        Assumed depths (a photo can't show depth): facade {Math.round(ASSUMED_DEPTH.facade * 100)} cm thick, this part {Math.round(partDepth(region?.kind ?? "custom") * 100)} cm. Look around it in “3D projection”.
      </p>
      <button className="ghost danger" onClick={() => removePart(o.id)}>
        Stop it moving
      </button>
    </section>
  );
};
