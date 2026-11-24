import { useState, type CSSProperties, type Ref } from "react";
import { COPY } from "./copy";
import {
  FILTER_IDS,
  FULL_POSITIONS,
  formatValue,
  isFiltering,
  SLIDER_STEPS,
  valueAt,
  type FilterId,
  type FilterPositions,
  type FilterScales,
} from "./filters";

interface Props {
  scales: FilterScales;
  positions: FilterPositions;
  onChange: (positions: FilterPositions) => void;
  /** Whether the panel is painted into the plot, leaving the HTML invisible on top for input. */
  isPainted: boolean;
  ref?: Ref<HTMLElement>;
}

/** A slider with two thumbs, for the low and high ends of a range. */
function RangeSlider({
  id,
  scales,
  value,
  onChange,
}: {
  id: FilterId;
  scales: FilterScales;
  value: [number, number];
  onChange: (value: [number, number]) => void;
}) {
  const [low, high] = value;
  const label = COPY.filters.names[id];
  const unit = COPY.filters.units[id];
  const format = (position: number) => `${formatValue(id, valueAt(scales[id], position))}${unit ? ` ${unit}` : ""}`;
  return (
    <div className="filter-row">
      <div className="filter-heading">
        <span className="filter-name">{label}</span>
        <output className="filter-value">
          {format(low)} – {format(high)}
        </output>
      </div>
      <div
        className="filter-range"
        style={{ "--low": `${(low / SLIDER_STEPS) * 100}%`, "--high": `${(high / SLIDER_STEPS) * 100}%` } as CSSProperties}
      >
        <div className="filter-track" aria-hidden="true" />
        <input
          type="range"
          min={0}
          max={SLIDER_STEPS}
          value={low}
          aria-label={`${label} ${COPY.filters.minimum}`}
          aria-valuetext={format(low)}
          onChange={(event) => onChange([Math.min(Number(event.target.value), high), high])}
        />
        <input
          type="range"
          min={0}
          max={SLIDER_STEPS}
          value={high}
          aria-label={`${label} ${COPY.filters.maximum}`}
          aria-valuetext={format(high)}
          onChange={(event) => onChange([low, Math.max(Number(event.target.value), low)])}
        />
      </div>
    </div>
  );
}

/** Sliders that limit which asteroids are shown. Planets are never filtered. */
export function FilterPanel({ scales, positions, onChange, isPainted, ref }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <section ref={ref} className={`filters ${isPainted ? "is-painted" : ""}`} aria-label={COPY.filters.title}>
      <div className="filters-header">
        <button
          type="button"
          className="filters-toggle"
          aria-expanded={isOpen}
          aria-controls="filters-body"
          onClick={() => setIsOpen((open) => !open)}
        >
          <span>{COPY.filters.title}</span>
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
            <path d={isOpen ? "M2 4.5l4 4 4-4" : "M2 7.5l4-4 4 4"} stroke="currentColor" strokeWidth="1.4" fill="none" />
          </svg>
        </button>
        {isFiltering(positions) && (
          <button type="button" className="filters-reset" onClick={() => onChange(FULL_POSITIONS)}>
            {COPY.filters.reset}
          </button>
        )}
      </div>
      {isOpen && (
        <div id="filters-body" className="filters-body">
          {FILTER_IDS.map((id) => (
            <RangeSlider
              key={id}
              id={id}
              scales={scales}
              value={positions[id]}
              onChange={(value) => onChange({ ...positions, [id]: value })}
            />
          ))}
        </div>
      )}
    </section>
  );
}
