/**
 * Areas panel: "Find areas automatically" — asks before downloading the models, shows progress
 * (with Cancel) while the photo is analysed in the background, then lists what was found for review.
 */
import { KIND_LABEL } from "../studio/actions.ts";
import { activeVenue, useStudio } from "../studio/store.ts";
import { useTrace } from "./traceStore.ts";
import { acceptProposals, cancelDetection, discardProposals, findAreasAutomatically, proposedAreas, useHouseSetup } from "./houseSetup.ts";

const FindAreas = () => {
  const { phase, fraction, text, error, status, summary } = useHouseSetup();
  const project = useStudio((s) => s.project)!;
  const venue = activeVenue({ project });
  const hasPhoto = !!venue?.referenceAssetId && !!project.assets[venue.referenceAssetId];
  if (phase === "consent" && status)
    return (
      <div className="house-setup" role="region" aria-label="Download the detection models">
        <strong>Download the detection models?</strong>
        <p className="small">
          Finding areas uses two open models that run on this computer. They're downloaded once from Hugging Face ({status.downloadMB} MB) into {status.modelsDir}. Your photo is never uploaded.
        </p>
        <ul className="models small">
          {status.models.map((m) => (
            <li key={m.id}>
              {m.role} — {m.id}, {m.license}, {m.sizeMB} MB{m.present ? " (already here)" : ""}
            </li>
          ))}
        </ul>
        <div className="row gap">
          <button className="primary" onClick={() => void findAreasAutomatically({ allowDownload: true })}>
            Download and find areas
          </button>
          <button className="ghost" onClick={() => useHouseSetup.setState({ phase: "idle" })}>
            Not now
          </button>
        </div>
      </div>
    );
  if (phase === "running")
    return (
      <div className="house-setup" role="region" aria-label="Finding areas" aria-busy="true">
        <strong>Finding areas in the photo…</strong>
        <div className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
          <div style={{ width: `${Math.round(fraction * 100)}%` }} />
        </div>
        <span className="muted small">{text} · you can keep working meanwhile</span>
        <div>
          <button className="ghost" onClick={() => void cancelDetection()}>
            Cancel
          </button>
        </div>
      </div>
    );
  return (
    <div className="house-setup">
      <button className="primary" disabled={!hasPhoto} onClick={() => void findAreasAutomatically()} title={hasPhoto ? undefined : "Start a show from a photo of the building first"}>
        Find areas automatically
      </button>
      <p className="muted small">Looks for the windows, doors, garage door, lights, roofline and the house itself in your photo. You check everything before it's used.</p>
      {phase === "failed" && error && (
        <p className="warn small" role="alert">
          {error}
        </p>
      )}
      {phase === "cancelled" && <p className="muted small">Stopped. Nothing was changed.</p>}
      {phase === "done" && summary && (
        <p className="small" role="status">
          Found {summary.added} area{summary.added === 1 ? "" : "s"} in {summary.seconds.toFixed(0)} s{summary.device === "cpu" ? " (on the processor)" : ""}
          {summary.uncertain ? `, ${summary.uncertain} to check` : ""}
          {summary.skipped ? ` · ${summary.skipped} already traced` : ""}.{summary.notes.length ? ` ${summary.notes.join(" ")}` : ""}
        </p>
      )}
    </div>
  );
};

/** Areas found automatically, waiting to be checked. */
const ProposalReview = () => {
  const project = useStudio((s) => s.project)!;
  const sel = useStudio((s) => s.selection.regionIds);
  const venue = activeVenue({ project });
  const found = proposedAreas(venue);
  if (!found.length) return null;
  const toCheck = found.filter((r) => r.proposal!.uncertain).length;
  return (
    <div className="suggest-box" role="region" aria-label="Areas found automatically">
      <strong>
        {found.length} area{found.length === 1 ? "" : "s"} found{toCheck ? ` · ${toCheck} to check` : ""}
      </strong>
      <p className="muted small">
        Dashed outlines are proposals (amber: may be wrong). Select one to drag its corners into place, change its kind on the right, or split and join areas below. Effects don't use them until you accept.
      </p>
      <div className="proposal-list">
        {found.map((r) => (
          <div key={r.id} className="proposal-row">
            <button
              className={`list-item ${sel.includes(r.id) ? "on" : ""}`}
              onClick={(e) => {
                // Reviewing means reshaping: switch to the Select tool so the corners can be dragged.
                useTrace.getState().set({ tool: "select", draft: [], pending: null });
                useStudio.getState().selectRegions([r.id], e.shiftKey || e.ctrlKey);
              }}
            >
              {r.name} <span className="muted small">· {KIND_LABEL[r.kind][0]}</span>
            </button>
            <span className="score" title="How sure the detector was">
              {Math.round(r.proposal!.score * 100)}%
            </span>
            <button className="icon small" title="Accept" aria-label={`Accept ${r.name}`} onClick={() => acceptProposals([r.id])}>
              ✓
            </button>
            <button className="icon small" title="Remove" aria-label={`Remove ${r.name}`} onClick={() => discardProposals([r.id])}>
              ✕
            </button>
            {r.proposal!.uncertain && <span className="why">{r.proposal!.uncertain}</span>}
          </div>
        ))}
      </div>
      <div className="row gap wrap">
        <button className="primary" onClick={() => acceptProposals()}>
          Accept all {found.length}
        </button>
        {sel.some((id) => found.some((r) => r.id === id)) && (
          <button className="ghost" onClick={() => acceptProposals(sel)}>
            Accept selected
          </button>
        )}
        <button className="ghost" onClick={() => discardProposals()}>
          Remove all
        </button>
      </div>
    </div>
  );
};

export const HouseSetupPanel = () => (
  <>
    <FindAreas />
    <ProposalReview />
  </>
);
