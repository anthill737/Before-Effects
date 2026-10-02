/**
 * After dropping content on one of several selected areas: repeat it in each area, or span one
 * continuous picture across all of them. The little pictures show the difference.
 */
import { getRecipe } from "@be/core";
import { finishDrop, useDropChoice } from "./assign.ts";
import { useStudio } from "./store.ts";

const RepeatIcon = () => (
  <svg viewBox="0 0 120 50" className="drop-icon" aria-hidden="true">
    {[0, 1, 2].map((i) => (
      <g key={i} transform={`translate(${6 + i * 38},6)`}>
        <rect width="32" height="38" rx="2" className="frame" />
        <circle cx="16" cy="15" r="7" className="sun" />
        <path d="M2 36 L12 24 L19 30 L25 22 L30 36 Z" className="hill" />
      </g>
    ))}
  </svg>
);

const SpanIcon = () => (
  <svg viewBox="0 0 120 50" className="drop-icon" aria-hidden="true">
    <defs>
      <clipPath id="span-clip">
        {[0, 1, 2].map((i) => (
          <rect key={i} x={6 + i * 38} y={6} width="32" height="38" rx="2" />
        ))}
      </clipPath>
    </defs>
    <g clipPath="url(#span-clip)">
      <rect x="0" y="0" width="120" height="50" className="sky" />
      <circle cx="60" cy="18" r="11" className="sun" />
      <path d="M0 50 L30 22 L52 38 L76 18 L120 50 Z" className="hill" />
    </g>
    {[0, 1, 2].map((i) => (
      <rect key={i} x={6 + i * 38} y={6} width="32" height="38" rx="2" className="frame" fill="none" />
    ))}
  </svg>
);

export const DropChooser = () => {
  const pending = useDropChoice((s) => s.pending);
  const project = useStudio((s) => s.project);
  if (!pending || !project) return null;
  const what = pending.payload.kind === "asset" ? (project.assets[pending.payload.id]?.name ?? "this") : (getRecipe(pending.payload.id)?.title ?? "this effect");
  const n = pending.areaIds.length;
  return (
    <div className="drop-chooser" role="dialog" aria-label="Repeat or span" style={{ left: Math.min(pending.x, window.innerWidth - 340), top: Math.min(pending.y, window.innerHeight - 260) }}>
      <strong>
        Put “{what}” in the {n} selected areas
      </strong>
      <div className="drop-options">
        <button className="drop-option" onClick={() => void finishDrop(pending.payload, pending.areaIds, "each")}>
          <RepeatIcon />
          <span>Repeat in each area</span>
          <span className="muted small">A full copy in every area</span>
        </button>
        <button className="drop-option" onClick={() => void finishDrop(pending.payload, pending.areaIds, "across")}>
          <SpanIcon />
          <span>Span across areas</span>
          <span className="muted small">One picture, continuous across them</span>
        </button>
      </div>
      <button className="link small" onClick={() => useDropChoice.setState({ pending: null })}>
        Cancel
      </button>
    </div>
  );
};
