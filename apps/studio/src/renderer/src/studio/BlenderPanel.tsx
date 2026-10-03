/**
 * Blender in the inspector: physical effects for selected areas (smoke, fire, water, cloth —
 * simulated by Blender), and, on a layer Blender made, opening the .blend, updating after edits,
 * and re-rendering at another length or quality. Progress shows while Blender works; Cancel stops it.
 */
import { BLENDER_EFFECTS, type BlenderEffectKind, type BlenderLink } from "@be/core";
import { useEffect, useState } from "react";
import { blendChanged, blenderEffect, cancelBlender, linkBlendFile, openInBlender, rebuildBlenderEffect, STAGES, updateFromBlender, useBlenderJobs } from "./blenderEffects.ts";
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
    </section>
  );
};
