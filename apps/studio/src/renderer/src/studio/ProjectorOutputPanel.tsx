/**
 * "Show on projector": choose the display the projector is connected to (with numbered
 * identification), open a full-screen output with no editor UI, and switch test patterns while
 * aligning. Physical alignment stays "unverified" until checked against the real surface.
 */
import { useEffect, useRef, useState } from "react";
import type { DisplayInfo, OutputStatus, TestPattern } from "../../../shared/api.ts";
import { openAlign } from "./align/alignSession.ts";
import { useStudio } from "./store.ts";

const PATTERNS: Array<{ id: TestPattern; label: string; hint: string }> = [
  { id: "none", label: "Show", hint: "The show itself" },
  { id: "identify", label: "Identify", hint: "Big number and size, to confirm this is the right projector" },
  { id: "grid", label: "Grid", hint: "Straight lines for checking alignment" },
  { id: "checker", label: "Checker", hint: "Checkerboard for focus" },
  { id: "white", label: "White", hint: "Full white for coverage and brightness" },
  { id: "black", label: "Black", hint: "Blackout" },
  { id: "colors", label: "Colors", hint: "Color bars" },
];

export const ProjectorOutputPanel = ({ venueId, projectorId }: { venueId: string; projectorId: string }) => {
  const project = useStudio((s) => s.project)!;
  const projector = project.venues[venueId]?.projectors[projectorId];
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [displayId, setDisplayId] = useState<number | null>(null);
  const [outputs, setOutputs] = useState<OutputStatus[]>([]);
  const [pattern, setPattern] = useState<TestPattern>("none");
  const displaysSeen = useRef(0);

  const saved = projector?.output.displayId;
  useEffect(() => {
    // Displays are re-listed every second, so a projector plugged in (or Windows switched to
    // Extend) shows up without reopening anything.
    const list = () =>
      void window.be.displays.list().then((d) => {
        setDisplays((old) => (JSON.stringify(old) === JSON.stringify(d) ? old : d));
        // The display this projector was last shown on, if it's connected; else one that isn't the
        // main screen (projectors are usually external). A choice of the main screen made only
        // because nothing else was connected moves to the projector when it appears.
        const remembered = d.find((x) => String(x.id) === saved);
        const pick = (remembered ?? d.find((x) => !x.primary) ?? d[0])?.id ?? null;
        setDisplayId((cur) => {
          const still = d.find((x) => x.id === cur);
          return still && !(still.primary && d.length > 1 && displaysSeen.current <= 1) ? cur : pick;
        });
        displaysSeen.current = d.length;
      });
    list();
    void window.be.windows.outputs().then(setOutputs);
    // Output health: what each output is showing, refreshed every second.
    const t = setInterval(() => {
      list();
      void window.be.windows.outputs().then(setOutputs);
    }, 1000);
    const off = window.be.windows.onWindowsChanged((w) => setOutputs(w.outputs));
    return () => {
      clearInterval(t);
      off();
    };
  }, [saved]);

  if (!projector) return null;
  const status = outputs.find((o) => o.projectorId === projectorId);
  const open = status?.open ? status : undefined;
  const chosen = displays.find((d) => d.id === (open?.displayId ?? displayId));
  const mismatch = chosen && (chosen.pixels.width !== projector.output.width || chosen.pixels.height !== projector.output.height);
  const onlyOne = displays.length <= 1;

  const openOutput = async (p: TestPattern) => {
    if (displayId === null) return;
    setPattern(p);
    // Remember the display for this projector (saved with the project).
    if (projector.output.displayId !== String(displayId))
      useStudio.getState().apply({ type: "projector.update", args: { venueId, projectorId, changes: { output: { ...projector.output, displayId: String(displayId) } } } }, { label: `Show ${projector.name} on this display` });
    await window.be.windows.openOutput({ venueId, projectorId, displayId, pattern: p });
  };

  return (
    <section className="projector-output">
      <h3 className="subhead">Show on the projector</h3>
      <label className="row-field">
        <span>Display</span>
        <select value={displayId ?? ""} onChange={(e) => setDisplayId(Number(e.target.value))} aria-label="Display connected to the projector">
          {displays.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
              {d.primary ? " (main screen)" : ""}
            </option>
          ))}
        </select>
      </label>
      <div className="row gap wrap">
        <button className="ghost small-btn" onClick={() => void window.be.displays.identify()} title="Shows a big number on every connected display for a few seconds">
          Identify displays
        </button>
        <button className="primary" onClick={() => void openAlign(venueId, projectorId).catch(() => {})} title="Align this projector to the house with your phone's camera">
          Auto-align with phone
        </button>
        {!open ? (
          <button className="primary" onClick={() => void openOutput("none")} disabled={displayId === null}>
            Open projector output
          </button>
        ) : (
          <button className="ghost" onClick={() => void window.be.windows.closeOutput(projectorId)}>
            Close projector output
          </button>
        )}
      </div>
      {status?.waiting && (
        <p className="warn small" role="status">
          {status.displayLabel} was disconnected. The output reopens on it as soon as it's connected again.
        </p>
      )}
      {onlyOne && (
        <p className="warn small">
          Only this screen is connected. To show on the projector while you keep editing here, plug it in and press Win+P → Extend; it appears in this list by itself.
        </p>
      )}
      {open && (
        <>
          <div className="segmented wrap" role="radiogroup" aria-label="Test pattern">
            {PATTERNS.map((p) => (
              <button
                key={p.id}
                role="radio"
                aria-checked={pattern === p.id}
                className={pattern === p.id ? "on" : ""}
                title={p.hint}
                onClick={() => {
                  setPattern(p.id);
                  void window.be.windows.setOutputPattern(projectorId, p.id);
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="muted small">
            Output on {open.displayLabel} at {projector.output.width}×{projector.output.height}. The preview size setting never changes this.
          </p>
          <p className="muted small" role="status">
            {open.showing ? `Showing frame ${open.showing.frame}${Date.now() - open.showing.at < 1500 ? ` · ${open.showing.fps} frames/s` : " (paused)"}` : "Starting…"}
          </p>
        </>
      )}
      {mismatch && chosen && (
        <p className="warn small">
          This display is {chosen.pixels.width}×{chosen.pixels.height}, but {projector.name} is set to {projector.output.width}×{projector.output.height}. The image will be scaled; set the
          projector size to match for pixel-exact output.
        </p>
      )}
      <p className="muted small">Physical alignment: not yet verified on real hardware.</p>
    </section>
  );
};
