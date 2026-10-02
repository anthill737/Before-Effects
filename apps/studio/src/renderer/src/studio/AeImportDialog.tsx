/**
 * Shown while an After Effects project opens, then as its compatibility report: what came across,
 * what was approximated, what is kept but not shown yet, and what is missing — in plain words.
 */
import { useEffect, useRef } from "react";
import { useAeImport } from "./aeImport.ts";
import { findMissingInFolder } from "./relink.ts";

const GROUPS = [
  { level: "missing", title: "Missing", hint: "Not found or not readable. Relink media or recreate these.", icon: "✗" },
  { level: "not-imported", title: "Not imported yet", hint: "Features Before Effects doesn't have yet.", icon: "–" },
  { level: "kept", title: "Kept, not shown yet", hint: "Saved with your show and editable, but not rendered yet.", icon: "◐" },
  { level: "approximated", title: "Approximated", hint: "Came across close to the original, with small differences.", icon: "≈" },
  { level: "exact", title: "Notes", hint: "", icon: "i" },
] as const;

export const AeImportDialog = () => {
  const st = useAeImport();
  const ref = useRef<HTMLDialogElement>(null);
  const open = st.phase !== "idle";
  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    if (!open && ref.current?.open) ref.current.close();
  }, [open]);
  const close = () => useAeImport.setState({ phase: "idle" });
  const r = st.report;
  return (
    <dialog ref={ref} className="ae-import" aria-labelledby="ae-import-title" onCancel={(e) => (st.phase === "reading" || st.phase === "media" ? e.preventDefault() : close())}>
      {(st.phase === "reading" || st.phase === "media") && (
        <>
          <h2 id="ae-import-title">Opening “{st.fileName}”</h2>
          <p className="muted">{st.detail}</p>
          <progress />
        </>
      )}
      {st.phase === "failed" && (
        <>
          <h2 id="ae-import-title">“{st.fileName}” couldn't be opened</h2>
          <p className="warn">{st.error}</p>
          <p className="muted small">If you have After Effects, run the Before Effects exporter script there (tools\ae-exporter\BeforeEffectsExport.jsx) and open the file it saves.</p>
          <div className="row gap end">
            <button className="primary" onClick={close}>
              Close
            </button>
          </div>
        </>
      )}
      {st.phase === "done" && r && (
        <>
          <div className="export-head">
            <h2 id="ae-import-title">Opened “{r.sourceName}”</h2>
            <button className="icon" onClick={close} aria-label="Close">
              ✕
            </button>
          </div>
          <p className="muted small">
            {r.route === "aep-file" ? "Read directly from the .aep file. After Effects wasn't needed." : "From the Before Effects exporter, run inside After Effects."} The groups below say how each layer is drawn. None of it has been compared with After Effects frame by frame.
          </p>
          <div className="ae-fidelity" role="list" aria-label="How the layers came across">
            <span role="listitem" className="fid drawn" title="Drawn by Before Effects with nothing reported missing">
              <strong>{r.layerFidelity.drawn}</strong> drawn
            </span>
            <span role="listitem" className="fid approx" title="Drawn, but something about the layer is approximated, not drawn yet, or missing (see below)">
              <strong>{r.layerFidelity.approximated}</strong> drawn with approximations
            </span>
            <span role="listitem" className="fid kept" title="Kept in the show with its settings but not drawn yet (e.g. cameras, lights)">
              <strong>{r.layerFidelity.preservedNotDrawn}</strong> kept, not drawn
            </span>
            <span role="listitem" className="fid none" title="Couldn't be imported">
              <strong>{r.layerFidelity.notImported}</strong> not imported
            </span>
          </div>
          <dl className="ae-counts">
            <div>
              <dt>Compositions</dt>
              <dd>{r.counts.compositions}</dd>
            </div>
            <div>
              <dt>Layers</dt>
              <dd>{r.counts.layers}</dd>
            </div>
            <div>
              <dt>Keyframes</dt>
              <dd>{r.counts.keyframes}</dd>
            </div>
            <div>
              <dt>Masks</dt>
              <dd>{r.counts.masks}</dd>
            </div>
            <div>
              <dt>Effects</dt>
              <dd>
                {r.counts.effects}
                {r.counts.effects ? <span className="muted small"> · {r.counts.effectsRendered} shown now</span> : null}
              </dd>
            </div>
            <div>
              <dt>Media files</dt>
              <dd>
                {r.counts.media}
                {r.counts.mediaMissing ? <span className="warn small"> · {r.counts.mediaMissing} to relink</span> : null}
              </dd>
            </div>
          </dl>
          <div className="ae-notes">
            {GROUPS.map((g) => {
              const ns = r.notes.filter((n) => n.level === g.level);
              if (!ns.length) return null;
              return (
                <details key={g.level} className={`ae-group ${g.level}`} open={g.level === "missing"}>
                  <summary>
                    <span className="ae-icon" aria-hidden="true">
                      {g.icon}
                    </span>{" "}
                    <strong>{g.title}</strong> <span className="muted small">({ns.length})</span> {g.hint && <span className="muted small">— {g.hint}</span>}
                  </summary>
                  <ul>
                    {ns.map((n, i) => (
                      <li key={i}>
                        <span className="muted small">{n.where}</span>
                        <br />
                        {n.text}
                      </li>
                    ))}
                  </ul>
                </details>
              );
            })}
          </div>
          <p className="muted small">Your original file is unchanged. A copy of it and this report are kept with the show.</p>
          <div className="row gap end">
            {r.counts.mediaMissing > 0 && (
              <button
                className="ghost"
                onClick={async () => {
                  const res = await findMissingInFolder();
                  if (res) useAeImport.setState({ report: { ...r, counts: { ...r.counts, mediaMissing: res.total - res.found } } });
                }}
              >
                Find missing files…
              </button>
            )}
            {st.reportPath && (
              <button className="ghost" onClick={() => void window.be.files.showInFolder(st.reportPath!)}>
                Show report file
              </button>
            )}
            <button className="primary" onClick={close} autoFocus>
              Start working
            </button>
          </div>
        </>
      )}
    </dialog>
  );
};
