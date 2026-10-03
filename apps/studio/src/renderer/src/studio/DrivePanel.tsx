/**
 * Google Drive (through Google Drive for desktop): Before Effects' folder in My Drive, bringing in media
 * from anywhere in Drive (local copies only of what's chosen), and saving and opening show packages.
 * Caches stay on this computer; exports are sent from Renders once they're finished.
 */
import { useEffect, useState } from "react";
import type { DriveStatus } from "../../../shared/api.ts";
import { importFromDrive, openPackageFromDrive, plainError, savePackageToDrive } from "./drive.ts";
import { useStudio } from "./store.ts";

type Kind = "folder" | "exports" | "projects" | "media";
const ROWS: Array<{ kind: Kind; label: string; hint: string }> = [
  { kind: "folder", label: "Before Effects' folder", hint: "The other folders are made inside it unless you choose your own" },
  { kind: "exports", label: "Finished exports", hint: "Where “Send to Google Drive” puts exported videos" },
  { kind: "projects", label: "Show packages", hint: "Where “Save show to Drive” puts a show and its media" },
  { kind: "media", label: "Media you save", hint: "Where files sent to Drive by agents go" },
];
const place = (rel: string) => ["My Drive", ...rel.split("/").filter(Boolean)].join(" › ");

const size = (b: number) => (b < 1e6 ? `${Math.max(1, Math.round(b / 1e3))} KB` : b < 1e9 ? `${(b / 1e6).toFixed(0)} MB` : `${(b / 1e9).toFixed(1)} GB`);

export const DriveButton = () => {
  const [open, setOpen] = useState(false);
  return (
    <div className="tool-pop">
      <button className="ghost" onClick={() => setOpen(!open)} aria-expanded={open} title="Google Drive: bring in media, save and open show packages">
        Drive
      </button>
      {open && <DrivePanel onClose={() => setOpen(false)} />}
    </div>
  );
};

const DrivePanel = ({ onClose }: { onClose: () => void }) => {
  const [st, setSt] = useState<DriveStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [armed, setArmed] = useState(false);
  const hasShow = useStudio((s) => !!s.project);
  const dirty = useStudio((s) => s.dirty);
  const refresh = () => void window.be.drive.status().then(setSt);
  useEffect(refresh, []);
  const run = async (label: string, fn: () => Promise<string | null>) => {
    setBusy(label);
    setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ ok: true, text });
    } catch (e) {
      setMsg({ ok: false, text: plainError(e) });
    } finally {
      setBusy(null);
      refresh();
    }
  };
  return (
    <div className="popover renders drive" role="dialog" aria-label="Google Drive">
      <div className="row gap">
        <strong className="grow">Google Drive</strong>
        <button className="icon small" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      {!st && <p className="muted small">Looking for Google Drive…</p>}
      {st && !st.myDrive && (
        <>
          <p className="warn small">{st.problem}</p>
          <button
            className="ghost small-btn"
            onClick={() =>
              void run("locate", async () => {
                const p = await window.be.files.chooseFolder("Where is My Drive? Choose the “My Drive” folder itself (not a folder inside it)");
                return p ? ((await window.be.drive.setMyDrive(p)).notice ?? null) : null;
              })
            }
          >
            My Drive is somewhere else…
          </button>
        </>
      )}
      {st?.myDrive && (
        <>
          <p className="muted small">
            My Drive: {st.myDrive} ·{" "}
            {st.app === "running" ? "Google Drive for desktop is running" : <span className="warn">Google Drive for desktop isn't running — start it so files upload and download</span>}
          </p>
          <h3 className="subhead">Where things go in your Drive</h3>
          <div className="drive-folders">
            {ROWS.map(({ kind, label, hint }) => {
              const rel = kind === "folder" ? st.places?.base : st.places?.[kind];
              const full = kind === "folder" ? st.paths?.base : st.paths?.[kind];
              const own = kind !== "folder" && st.custom?.[kind];
              return (
                <div key={kind} className="drive-folder" title={hint}>
                  <span className="small">{label}</span>
                  <button className="link small ellipsis" title={`${full}\nOpen it`} onClick={() => full && void window.be.files.openPath(full)}>
                    {rel !== undefined ? place(rel) : "…"}
                  </button>
                  <span className="row gap">
                    <button
                      className="ghost small-btn"
                      disabled={!!busy}
                      onClick={() =>
                        void run(kind, async () => {
                          const r = await window.be.drive.chooseFolder(kind);
                          if (!r) return null;
                          const now = kind === "folder" ? r.places?.base : r.places?.[kind];
                          return r.notice ?? `${label}: ${place(now ?? "")}.`;
                        })
                      }
                    >
                      Choose…
                    </button>
                    {(own || (kind === "folder" && st.folder !== "Before Effects")) && (
                      <button className="link small" disabled={!!busy} title="Back to the usual place" onClick={() => void run(kind, async () => (await window.be.drive.setFolder(null, kind), null))}>
                        Reset
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
          {st.warnings?.map((w) => (
            <p key={w} className="warn small">
              {w}
            </p>
          ))}
          <p className="muted small">Caches and working files stay on this computer ({st.cache}), never in Drive.</p>
          <div className="row gap wrap">
            <button
              className="ghost small-btn"
              disabled={!hasShow || !!busy}
              title="Pictures, video or sound from anywhere in your Drive: only the files you choose are copied to this computer"
              onClick={() =>
                void run("import", async () => {
                  const added = await importFromDrive();
                  return added.length ? `Brought in ${added.length} file${added.length > 1 ? "s" : ""} (copied to this computer).` : null;
                })
              }
            >
              Bring in media from Drive…
            </button>
            <button
              className="ghost small-btn"
              disabled={!hasShow || !!busy}
              title="The show and every file it uses, into Projects in Before Effects' folder"
              onClick={() =>
                void run("save", async () => {
                  const r = await savePackageToDrive();
                  return `Saved “${r.rel}” (${r.files} files, ${size(r.bytes)}) into your Drive folder. ${r.note}`;
                })
              }
            >
              {busy === "save" ? "Saving to Drive…" : "Save show to Drive"}
            </button>
            <button
              className="ghost small-btn"
              disabled={!!busy}
              title="Choose a package's package.json; its media are copied to this computer"
              onClick={() =>
                void run("open", async () => {
                  if (dirty && !armed) {
                    setArmed(true);
                    throw new Error("The open show has unsaved changes. Save it first, or click “Open a show from Drive…” again to open the package anyway.");
                  }
                  setArmed(false);
                  const r = await openPackageFromDrive();
                  return r ? `Opened (${r.files} files, ${size(r.bytes)} copied to this computer).` : null;
                })
              }
            >
              {busy === "open" ? "Opening from Drive…" : "Open a show from Drive…"}
            </button>
            {st.paths && (
              <button className="link small" onClick={() => void window.be.files.openPath(st.ready ? st.paths!.base : st.myDrive!)}>
                Open the folder
              </button>
            )}
          </div>
        </>
      )}
      {msg && <p className={`${msg.ok ? "ok-text" : "warn"} small`}>{msg.text}</p>}
    </div>
  );
};
