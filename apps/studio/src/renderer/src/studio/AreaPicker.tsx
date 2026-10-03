/** Choose which traced areas something uses: every closed area of the building, as on/off chips. */
import { activeVenue, useStudio } from "./store.ts";

export const AreaPicker = ({ value, onChange, label = "Areas", min = 1 }: { value: readonly string[]; onChange: (ids: string[]) => void; label?: string; min?: number }) => {
  const project = useStudio((s) => s.project)!;
  const venue = activeVenue({ project });
  if (!venue) return null;
  const areas = venue.regionOrder.map((id) => venue.regions[id]!).filter((r) => r && r.path.closed && !r.proposal && r.kind !== "exclusion");
  const on = new Set(value);
  return (
    <div className="area-picker" role="group" aria-label={label}>
      {areas.map((r) => {
        const active = on.has(r.id);
        return (
          <button
            key={r.id}
            className={`chip ${active ? "on" : ""}`}
            aria-pressed={active}
            disabled={active && on.size <= min}
            title={active && on.size <= min ? "At least one area is needed" : active ? "Leave this area out" : "Use this area too"}
            onClick={() => onChange(active ? value.filter((id) => id !== r.id) : [...value, r.id])}
          >
            {r.name}
          </button>
        );
      })}
    </div>
  );
};
