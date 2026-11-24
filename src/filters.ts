import { FLOATS_PER_ORBIT } from "./data";
import { NO_FILTER, type OrbitFilter } from "./renderer";

export const FILTER_IDS = ["a", "diameter", "e"] as const;
export type FilterId = (typeof FILTER_IDS)[number];

/** Each slider runs over this many steps. */
export const SLIDER_STEPS = 1000;

/** A slider's range of values, spread evenly or on a log scale. */
export interface FilterScale {
  min: number;
  max: number;
  log: boolean;
}

export type FilterScales = Record<FilterId, FilterScale>;

/** Each filter's low and high slider positions, from 0 to SLIDER_STEPS. */
export type FilterPositions = Record<FilterId, [number, number]>;

export const FULL_POSITIONS: FilterPositions = {
  a: [0, SLIDER_STEPS],
  diameter: [0, SLIDER_STEPS],
  e: [0, SLIDER_STEPS],
};

/** Slider ranges covering every asteroid: semimajor axis and diameter on log scales. */
export function filterScales(orbits: Float32Array, count: number): FilterScales {
  let [aMin, aMax, logMin, logMax] = [Infinity, -Infinity, Infinity, -Infinity];
  for (let index = 0; index < count; index += 1) {
    const a = orbits[index * FLOATS_PER_ORBIT + 4]!;
    const logDiameter = orbits[index * FLOATS_PER_ORBIT + 9]!;
    aMin = Math.min(aMin, a);
    aMax = Math.max(aMax, a);
    logMin = Math.min(logMin, logDiameter);
    logMax = Math.max(logMax, logDiameter);
  }
  return {
    a: { min: aMin, max: aMax, log: true },
    diameter: { min: 10 ** logMin, max: 10 ** logMax, log: true },
    e: { min: 0, max: 1, log: false },
  };
}

/** The value at a slider position. */
export function valueAt({ min, max, log }: FilterScale, position: number) {
  const share = position / SLIDER_STEPS;
  return log ? 10 ** (Math.log10(min) + (Math.log10(max) - Math.log10(min)) * share) : min + (max - min) * share;
}

const isFull = ([low, high]: [number, number]) => low <= 0 && high >= SLIDER_STEPS;

export const isFiltering = (positions: FilterPositions) => FILTER_IDS.some((id) => !isFull(positions[id]));

/** The renderer's filter for some slider positions. A slider at its end doesn't limit that side. */
export function toOrbitFilter(positions: FilterPositions, scales: FilterScales): OrbitFilter {
  const range = (id: FilterId, transform: (value: number) => number = (value) => value): [number, number] => {
    const [low, high] = positions[id];
    return [
      low <= 0 ? NO_FILTER.a[0] : transform(valueAt(scales[id], low)),
      high >= SLIDER_STEPS ? NO_FILTER.a[1] : transform(valueAt(scales[id], high)),
    ];
  };
  return { a: range("a"), logDiameter: range("diameter", Math.log10), e: range("e") };
}

/** A value for display: two decimals below 1, one below 10, whole numbers above. */
export function formatValue(id: FilterId, value: number) {
  if (id === "e") return value.toFixed(2);
  if (value < 1) return value.toFixed(2);
  if (value < 10) return value.toFixed(1);
  return Math.round(value).toLocaleString();
}
