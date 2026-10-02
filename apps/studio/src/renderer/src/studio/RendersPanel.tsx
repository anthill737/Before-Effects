/**
 * Renders: background exports with progress, cancel and retry, the finished file and its check,
 * and delivery to Google Drive (Drive for desktop folder). A failed upload can be retried without
 * rendering again.
 */
import { useEffect, useState } from "react";
import type { RenderJob } from "../../../shared/api.ts";
import { useStudio } from "./store.ts";

const plain = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const mb = (b?: number) => (!b ? "" : b < 1e6 ? `${Math.max(1, Math.round(b / 1e3))} KB` : `${(b / 1e6).toFixed(b > 1e8 ? 0 : 1)} MB`);
const checkSummary = (j: RenderJob) => {
  const checks = j.verify?.checks ?? [];
  const bad = checks.filter((c) => !c.ok);
  return {
    text: !checks.length ? "" : bad.length ? `✗ ${bad.map((c) => c.name).join(", ")} not as expected` : "✓ checked",
    detail: checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.actual}${c.ok ? "" : ` (expected ${c.expected})`}`).join("\n"),
  };
};

export const useRenderJobs = (): RenderJob[] => {
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  useEffect(() => {
    void window.be.render.list().then(setJobs);
    return window.be.render.onUpdate(setJobs);
  }, []);
  return jobs;
};

export const RendersButton = () => {
  const jobs = useRenderJobs();
  const open = useStudio((s) => s.rendersOpen);
  const active = jobs.filter((j) => j.state === "rendering" || j.state === "queued");
  const running = jobs.find((j) => j.state === "rendering");
  const pct = running ? Math.round((running.done / Math.max(1, running.frames)) * 100) : 0;
  return (
    <div className="tool-pop">
      <button className={`ghost renders-btn ${active.length ? "busy" : ""}`} onClick={() => useStudio.setState({ rendersOpen: !open })} aria-expanded={open} title="Background exports">
        Renders{active.length ? ` · ${running ? `${pct}%` : "waiting"}${active.length > 1 ? ` (+${active.length - 1})` : ""}` : ""}
      </button>
      {open && <RendersPanel jobs={jobs} />}
    </div>
  );
};

const RendersPanel = ({ jobs }: { jobs: RenderJob[] }) => {
  const [drive, setDrive] = useState<string | null | undefined>(undefined);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    void window.be.deliver.driveFolder().then(setDrive);
  }, []);
  const list = [...jobs].reverse();
  return (
    <div className="popover renders" role="dialog" aria-label="Renders">
      <div className="row gap">
        <strong className="grow">Exports</strong>
        <button className="link small" onClick={() => void window.be.render.clearFinished()}>
          Clear finished
        </button>
        <button className="icon small" aria-label="Close" onClick={() => useStudio.setState({ rendersOpen: false })}>
          ✕
        </button>
      </div>
      {list.length === 0 && <p className="muted small">Nothing exported yet. Use “Export or play” in the top bar.</p>}
      {drive === null && list.some((j) => j.state === "done") && (
        <p className="muted small">To send exports to Google Drive, install Google Drive for desktop and sign in. A “Send to Google Drive” button then appears here.</p>
      )}
      {msg && <p className="warn small">{msg}</p>}
      {list.map((j) => (
        <div key={j.id} className={`render-job ${j.state}`}>
          <div className="row gap">
            <strong className="grow ellipsis" title={j.name}>
              {j.name}
            </strong>
            <span className="muted small">{j.state === "rendering" ? j.phase : j.state === "queued" ? "Waiting" : j.state === "done" ? "Ready" : j.state === "cancelled" ? "Cancelled" : "Failed"}</span>
          </div>
          {(j.state === "rendering" || j.state === "queued") && (
            <>
              <progress max={j.frames} value={j.done} />
              <div className="row gap">
                <span className="muted small grow">
                  {j.done} / {j.frames} frames{j.fps ? ` · ${j.fps} fps` : ""}
                  {j.etaSeconds !== undefined && j.state === "rendering" ? ` · about ${Math.max(1, j.etaSeconds)} s left` : ""}
                </span>
                <button className="link small" onClick={() => void window.be.render.cancel(j.id)}>
                  Cancel
                </button>
              </div>
            </>
          )}
          {j.state === "done" && j.result && (
            <>
              <p className="muted small ellipsis" title={`${j.result}\n${checkSummary(j).detail}`}>
                {j.result.split(/[\\/]/).pop()} · {mb(j.sizeBytes)} ·{" "}
                <span className={j.verify?.checks.every((c) => c.ok) ? "ok-text" : "warn"}>{checkSummary(j).text}</span>
              </p>
              <div className="row gap wrap">
                <button className="ghost small-btn" onClick={() => void window.be.files.showInFolder(j.result!)}>
                  Show in folder
                </button>
                {drive && j.delivery?.state !== "copied" && (
                  <button
                    className="ghost small-btn"
                    disabled={j.delivery?.state === "copying"}
                    onClick={async () => {
                      setMsg(null);
                      try {
                        await window.be.deliver.copyToDrive(j.id);
                      } catch (e) {
                        setMsg(plain(e));
                      }
                    }}
                  >
                    {j.delivery?.state === "copying" ? "Copying to Google Drive…" : j.delivery?.state === "failed" ? "Retry Google Drive" : "Send to Google Drive"}
                  </button>
                )}
                {j.delivery?.state === "copied" && (
                  <span className="ok-text small" title={j.delivery.target}>
                    ✓ In your Google Drive folder (Drive for desktop uploads it)
                  </span>
                )}
                {j.delivery?.state === "failed" && <span className="warn small">{j.delivery.error}</span>}
              </div>
            </>
          )}
          {j.state === "failed" && (
            <>
              <p className="warn small">{j.error}</p>
              <button className="ghost small-btn" onClick={() => void window.be.render.retry(j.id).catch((e) => setMsg(plain(e)))}>
                Try again
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
};
