/**
 * Guided export: what is the file for → where it goes, its exact size and length → render in the
 * background while you keep working. The export size is chosen here and only here. The preview
 * size never affects it, and full size is the default.
 */
import { formatSecondsFriendly, framesIn, timeToFrame } from "@be/core";
import type { PresetId } from "@be/media";
import { useEffect, useRef, useState } from "react";
import { hasAudio } from "./audioEngine.ts";
import { activeVenue, currentComp, useStudio } from "./store.ts";

type Outcome = "share" | "master" | "transparent" | "projector";

interface OutcomeDef {
  readonly id: Outcome;
  readonly title: string;
  readonly body: string;
  readonly preset: PresetId;
  readonly alpha: boolean;
  readonly mbps: number;
  readonly suffix: string;
}

const OUTCOMES: OutcomeDef[] = [
  { id: "share", title: "A video to share", body: "MP4 that plays on phones, browsers and Google Drive.", preset: "h264", alpha: false, mbps: 12, suffix: "share" },
  { id: "master", title: "A high-quality master", body: "ProRes 422 HQ for editing or archiving. Large files.", preset: "prores-422hq", alpha: false, mbps: 220, suffix: "master" },
  { id: "transparent", title: "A transparent animation", body: "ProRes 4444 with transparency, for layering in other software.", preset: "prores-4444", alpha: true, mbps: 330, suffix: "transparent" },
  { id: "projector", title: "Files for my projector", body: "The show already lined up for your projector — play it full-screen.", preset: "h264", alpha: false, mbps: 12, suffix: "projector-1" },
];

const SIZES = [
  { id: "full", label: "Full size", f: 1 },
  { id: "half", label: "Half size", f: 0.5 },
  { id: "quarter", label: "Quarter size (quick drafts)", f: 0.25 },
] as const;

const sanitize = (s: string) => s.replace(/[<>:"/\\|?*]+/g, "-").trim() || "Show";
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export const ExportDialog = () => {
  const open = useStudio((s) => s.exportOpen);
  const [outcome, setOutcome] = useState<OutcomeDef | null>(null);
  const [queued, setQueued] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<(typeof SIZES)[number]["id"]>("full");
  const [range, setRange] = useState<"show" | "preview">("show");
  const [projectorFormat, setProjectorFormat] = useState<"h264" | "hap">("h264");
  const [dir, setDir] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    void window.be.app.paths().then((p) => setDir(p.renders));
  }, []);
  useEffect(() => {
    if (open && !dialogRef.current?.open) dialogRef.current?.showModal();
    if (!open && dialogRef.current?.open) dialogRef.current.close();
    if (open) {
      setOutcome(null);
      setQueued(null);
      setError(null);
      setSize("full");
    }
  }, [open]);

  const s = useStudio.getState();
  const comp = currentComp(s);
  const venue = s.project ? activeVenue({ project: s.project }) : undefined;
  if (!comp || !s.project) return <dialog ref={dialogRef} />;
  const projector = venue?.projectorOrder[0] ? venue.projectors[venue.projectorOrder[0]] : undefined;
  const pr = s.range;
  const startFrame = range === "preview" && pr ? timeToFrame(pr.start, comp.frameRate) : 0;
  const endFrame = range === "preview" && pr ? timeToFrame(pr.end, comp.frameRate) : framesIn(comp.duration, comp.frameRate);
  const frames = Math.max(1, endFrame - startFrame);
  const seconds = frames / (comp.frameRate.num / comp.frameRate.den);
  const isProjector = outcome?.id === "projector";
  const full = isProjector && projector ? { width: projector.output.width, height: projector.output.height } : { width: comp.width, height: comp.height };
  const f = isProjector ? 1 : SIZES.find((x) => x.id === size)!.f;
  const delivered = { width: even(full.width * f), height: even(full.height * f) };
  const sound = hasAudio(s.project, comp.id);

  const start = async (o: OutcomeDef) => {
    setError(null);
    const snapshot = useStudio.getState().project!; // frozen now: later edits don't change this export
    const preset: PresetId = o.id === "projector" && projectorFormat === "hap" ? "hap" : o.preset;
    const ext = preset.startsWith("prores") || preset === "hap" ? "mov" : "mp4";
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const output = `${dir}\\${sanitize(snapshot.name)} - ${o.suffix}${range === "preview" && pr ? " (range)" : ""} ${stamp}.${ext}`;
    try {
      const id = await window.be.render.enqueue({
        name: `${snapshot.name} — ${o.title}`,
        outcome: o.id,
        preset,
        compId: comp.id,
        target: o.id === "projector" && venue && projector ? { kind: "projector", venueId: venue.id, projectorId: projector.id } : { kind: "master", keepAlpha: o.alpha },
        output,
        width: full.width,
        height: full.height,
        ...(f < 1 ? { deliverSize: delivered } : {}),
        frameRate: comp.frameRate,
        startFrame,
        frames,
        alpha: o.alpha,
        withAudio: sound && preset !== "png-sequence",
        estimatedBytes: Math.round(((o.mbps * 1e6) / 8) * seconds * f * f),
        snapshot: JSON.stringify(snapshot),
      });
      setQueued(id);
      useStudio.getState().toast({ kind: "info", text: "Exporting in the background — keep working. Progress is in Renders (top right)." });
    } catch (e) {
      setError(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };

  const close = () => useStudio.getState().setExportOpen(false);

  return (
    <dialog ref={dialogRef} className="export" onCancel={(e) => (e.preventDefault(), close())} aria-labelledby="export-title">
      <div className="export-head">
        <h2 id="export-title">Export</h2>
        <button className="icon" onClick={close} aria-label="Close">
          ✕
        </button>
      </div>

      {!outcome && (
        <>
          <p className="muted">What is this file for?</p>
          <div className="outcomes">
            {OUTCOMES.map((o) => (
              <button key={o.id} className="outcome" disabled={o.id === "projector" && !projector} onClick={() => setOutcome(o)}>
                <strong>{o.title}</strong>
                <span className="muted small">{o.body}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {outcome && !queued && (
        <>
          <h3>{outcome.title}</h3>
          <dl className="summary">
            <dt>Saves to</dt>
            <dd>{dir}</dd>
            <dt>Size</dt>
            <dd>
              {isProjector ? (
                <>
                  {full.width}×{full.height} — {projector?.name}'s output size
                </>
              ) : (
                <select value={size} onChange={(e) => setSize(e.target.value as typeof size)} aria-label="Export size">
                  {SIZES.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}: {even(full.width * x.f)}×{even(full.height * x.f)}
                    </option>
                  ))}
                </select>
              )}
              <div className="muted small">The preview size never affects exports.</div>
            </dd>
            <dt>Length</dt>
            <dd>
              {pr ? (
                <select value={range} onChange={(e) => setRange(e.target.value as "show" | "preview")} aria-label="Export range">
                  <option value="show">Whole show · {formatSecondsFriendly(comp.duration)}</option>
                  <option value="preview">Preview range only · {formatSecondsFriendly(pr.end - pr.start)}</option>
                </select>
              ) : (
                formatSecondsFriendly(comp.duration)
              )}{" "}
              · {frames} frames
            </dd>
            <dt>Sound</dt>
            <dd>{sound ? "Included (stereo, mixed from your sound layers)" : "None in this show"}</dd>
            <dt>File size</dt>
            <dd>about {Math.max(1, Math.round((outcome.mbps * seconds * f * f) / 8))} MB</dd>
          </dl>
          {isProjector && (
            <fieldset className="radio-list">
              <legend>How will you play it?</legend>
              <label>
                <input type="radio" checked={projectorFormat === "h264"} onChange={() => setProjectorFormat("h264")} /> From a laptop or player (MP4) — recommended
              </label>
              <label>
                <input type="radio" checked={projectorFormat === "hap"} onChange={() => setProjectorFormat("hap")} /> In a media server like Resolume or MadMapper (HAP)
              </label>
              <p className="muted small">The alignment for {projector?.name} is built into this file. Don't add mapping again in the player.</p>
            </fieldset>
          )}
          {error && <p className="warn">{error}</p>}
          <div className="row gap end">
            <button className="ghost" onClick={() => setOutcome(null)}>
              Back
            </button>
            <button className="primary" onClick={() => void start(outcome)}>
              Export
            </button>
          </div>
        </>
      )}

      {queued && (
        <>
          <h3>Exporting in the background</h3>
          <p>You can close this and keep working. The export uses the show exactly as it was when you pressed Export.</p>
          <p className="muted small">Follow progress, cancel, or open the finished file from Renders in the top bar.</p>
          <div className="row gap end">
            <button
              className="ghost"
              onClick={() => {
                setOutcome(null);
                setQueued(null);
              }}
            >
              Export something else
            </button>
            <button
              className="primary"
              onClick={() => {
                close();
                useStudio.setState({ rendersOpen: true });
              }}
            >
              Show progress
            </button>
          </div>
        </>
      )}
    </dialog>
  );
};
