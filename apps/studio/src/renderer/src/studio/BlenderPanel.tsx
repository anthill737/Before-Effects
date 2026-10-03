/**
 * Blender in the inspector: physical effects for selected areas (smoke, fire, water, cloth —
 * simulated by Blender), and, on a layer Blender made, opening the .blend, updating after edits,
 * and re-rendering at another length or quality. Progress shows while Blender works; Cancel stops it.
 */
import { BLENDER_EFFECTS, BLENDER_PARAMS, type BlenderEffectKind, type BlenderLink } from "@be/core";
import { useEffect, useState } from "react";
import { ColorField, Field, Slider } from "./controls.tsx";
import { AreaPicker } from "./AreaPicker.tsx";
import { blendChanged, blenderEffect, cancelBlender, linkBlendFile, openInBlender, rebuildBlenderEffect, renameBlenderLink, STAGES, updateFromBlender, useBlenderJobs } from "./blenderEffects.ts";
import { useStudio } from "./store.ts";

const useBlenderStatus = () => {
  const [st, setSt] = useState<{ found: boolean; version: string | null } | null>(null);
  useEffect(() => {
    void window.be.blender.status().then(setSt);
  }, []);
  return [st, setSt] as const;
};

const JobProgress = ({ linkId }: { linkId: string }) => {
  const job = useBlenderJobs((s) => s[linkId]);
  if (!job) return null;
  if (job.error) return <p className="warn small" role="alert">Blender: {job.error}</p>;
  if (!job.running) return null;
  return (
    <div className="blender-progress" role="status" aria-busy="true">
      <span className="small">
        {STAGES[job.stage] ?? job.stage}
        {job.total > 1 ? ` · ${job.done} of ${job.total}` : ""}
      </span>
      <div className="progress-bar">
        <div style={{ width: `${Math.round((job.done / Math.max(1, job.total)) * 100)}%` }} />
      </div>
      <button className="ghost small-btn" onClick={() => void cancelBlender(linkId)}>
        Cancel
      </button>
    </div>
  );
};

const report = (r: { ok: boolean; message?: string }) => {
  if (!r.ok && r.message && r.message !== "Cancelled.") useStudio.getState().toast({ kind: "error", text: r.message });
};

/** Physical effects for the selected areas, simulated in Blender. */
export const BlenderEffectButtons = ({ regionIds }: { regionIds: readonly string[] }) => {
  const [st, setSt] = useBlenderStatus();
  const jobs = useBlenderJobs();
  const busy = Object.values(jobs).some((j) => j.running);
  const pending = Object.entries(jobs).filter(([, j]) => j.running || j.error).map(([id]) => id);
  return (
    <div className="blender-effects" role="group" aria-label="Simulated in Blender">
      <h3 className="subhead">
        Simulated in Blender <span className="badge">physical</span>
      </h3>
      {st && !st.found ? (
        <p className="muted small">
          Blender isn't installed (or wasn't found).{" "}
          <button className="link small" onClick={() => void window.be.blender.choose().then((b) => setSt({ found: !!b, version: b?.version ?? null }))}>
            Choose blender.exe…
          </button>
        </p>
      ) : (
        <>
          <div className="row gap wrap">
            {(Object.keys(BLENDER_EFFECTS) as BlenderEffectKind[]).map((k) => (
              <button key={k} className="ghost" disabled={busy} title={BLENDER_EFFECTS[k].description} onClick={() => void blenderEffect(k, regionIds).then(report)}>
                {BLENDER_EFFECTS[k].title.replace(" (Blender)", "")}
              </button>
            ))}
          </div>
          <p className="muted small">
            Real simulation in Blender {st?.version ?? ""}, around the house (it flows past walls and drapes over them), lined up with your show. Takes a minute or two in the background.{" "}
            <button className="link small" disabled={busy} onClick={() => void linkBlendFile().then(report)}>
              Link your own .blend…
            </button>
          </p>
        </>
      )}
      {pending.map((id) => (
        <JobProgress key={id} linkId={id} />
      ))}
    </div>
  );
};

const hex = (c: readonly number[]) => `#${c.slice(0, 3).map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0")).join("")}`;
const rgb = (h: string) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, 1];

/**
 * Every setting of a Blender job: the effect's own (colour, thickness, swirl…), when it starts, how
 * long it lasts and the quality. Blender simulates again to apply them (a minute or two), so they're
 * gathered here and applied together with "Simulate again".
 */
const BlenderSettings = ({ link, busy }: { link: BlenderLink; busy: boolean }) => {
  const specs = link.effect ? BLENDER_PARAMS[link.effect.kind] : [];
  const saved = () => ({
    params: Object.fromEntries(specs.map((sp) => [sp.key, link.effect?.params[sp.key] ?? sp.default])) as Record<string, number | string>,
    regionIds: [...(link.effect?.regionIds ?? [])],
    startSeconds: link.startSeconds,
    seconds: link.seconds,
    quality: link.quality,
  });
  const [draft, setDraft] = useState(saved);
  // A different link (or one changed elsewhere, e.g. undo) resets the draft.
  useEffect(() => setDraft(saved()), [link]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = JSON.stringify(draft) !== JSON.stringify(saved());
  const setParam = (k: string, v: number | string) => setDraft((d) => ({ ...d, params: { ...d.params, [k]: v } }));
  const apply = () => void rebuildBlenderEffect(link.id, { params: draft.params, regionIds: draft.regionIds, startSeconds: draft.startSeconds, seconds: draft.seconds, quality: draft.quality }).then(report);
  return (
    <div className="blender-settings" role="group" aria-label="Blender settings">
      <h3 className="subhead">Settings</h3>
      <Field label="Name" help="Applies at once.">
        <input className="text-input" value={link.name} aria-label="Blender effect name" onChange={(e) => renameBlenderLink(link.id, e.target.value)} />
      </Field>
      {link.effect && (
        <Field label={link.effect.kind === "cloth" ? "Covers" : "Comes from"}>
          <AreaPicker value={draft.regionIds} onChange={(ids) => setDraft((d) => ({ ...d, regionIds: ids }))} />
        </Field>
      )}
      {specs.map((sp) => (
        <Field key={sp.key} label={sp.label} help={sp.help}>
          {sp.kind === "color" ? (
            <ColorField label={sp.label} value={rgb(String(draft.params[sp.key]))} onChange={(v) => setParam(sp.key, hex(v))} />
          ) : (
            <Slider label={sp.label} value={Number(draft.params[sp.key])} min={sp.min ?? 0} max={sp.max ?? 10} step={sp.step} unit={sp.unit} onChange={(v) => setParam(sp.key, v)} />
          )}
        </Field>
      ))}
      <Field label="Starts at">
        <Slider label="Starts at" value={draft.startSeconds} min={0} max={600} step={0.1} unit="s" onChange={(v) => setDraft((d) => ({ ...d, startSeconds: v }))} />
      </Field>
      <Field label="Lasts" help={link.origin === "linked" ? "Frames rendered from the file's own first frame." : undefined}>
        <Slider label="Lasts" value={draft.seconds} min={0.5} max={link.origin === "linked" ? 60 : 30} step={0.1} unit="s" onChange={(v) => setDraft((d) => ({ ...d, seconds: v }))} />
      </Field>
      <Field label="Quality" help="Draft: half size and a coarser simulation, quicker. Full: canvas size, finer detail, slower.">
        <div className="segmented" role="radiogroup" aria-label="Quality">
          {(["draft", "full"] as const).map((q) => (
            <button key={q} role="radio" aria-checked={draft.quality === q} className={draft.quality === q ? "on" : ""} onClick={() => setDraft((d) => ({ ...d, quality: q }))}>
              {q === "draft" ? "Draft" : "Full"}
            </button>
          ))}
        </div>
      </Field>
      <div className="row gap wrap">
        <button className={changed ? "primary" : "ghost"} disabled={busy || !changed} onClick={apply} title={link.origin === "effect" ? "Blender builds and simulates the effect again with these settings (replaces edits made in Blender)" : "Blender renders the file again"}>
          {link.origin === "effect" ? "Simulate again" : "Render again"}
        </button>
        {changed && (
          <button className="ghost" disabled={busy} onClick={() => setDraft(saved())}>
            Undo changes
          </button>
        )}
      </div>
      {changed && <p className="muted small">Not applied yet: Blender {link.origin === "effect" ? "simulates" : "renders"} again with these (a minute or two).</p>}
    </div>
  );
};

/** On a layer Blender made: open, update after editing, re-render. */
export const BlenderLinkSection = ({ link }: { link: BlenderLink }) => {
  const [changed, setChanged] = useState(false);
  const job = useBlenderJobs((s) => s[link.id]);
  useEffect(() => {
    void blendChanged(link).then(setChanged);
    const t = setInterval(() => void blendChanged(link).then(setChanged), 3000);
    return () => clearInterval(t);
  }, [link]);
  const busy = !!job?.running;
  return (
    <section className="param-group blender-link" aria-label="Made in Blender">
      <h3 className="subhead">
        Made in Blender <span className="badge">{link.origin === "effect" ? "physical" : "linked file"}</span>
      </h3>
      <p className="muted small">
        {link.effect ? BLENDER_EFFECTS[link.effect.kind].description : "Your Blender file, rendered and placed in the show."} {link.seconds} s, {link.quality === "full" ? "full quality" : "draft quality (half size)"}.
        {link.result ? ` Rendered ${new Date(link.result.renderedAt).toLocaleTimeString()}.` : ""}
      </p>
      {changed && (
        <p className="warn small" role="status">
          The Blender file changed since this render.
        </p>
      )}
      <div className="row gap wrap">
        <button className="ghost" disabled={busy} onClick={() => void openInBlender(link.id)}>
          Open in Blender
        </button>
        <button className={changed ? "primary" : "ghost"} disabled={busy} onClick={() => void updateFromBlender(link.id).then(report)} title="Render the Blender file again, with any changes made in Blender">
          Update from Blender
        </button>
        {link.quality === "draft" && (
          <button className="ghost" disabled={busy} onClick={() => void rebuildBlenderEffect(link.id, { quality: "full" }).then(report)} title={link.origin === "effect" ? "Rebuilds the effect at full size (replaces edits made in Blender)" : "Renders at full size"}>
            Render at full quality
          </button>
        )}
      </div>
      <JobProgress linkId={link.id} />
      <BlenderSettings link={link} busy={busy} />
    </section>
  );
};
