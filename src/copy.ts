import type { SpeedUnit } from "./time";

/**
 * Every string the app shows. Placeholder text until real copy is written.
 */
export const COPY = {
  title: "Lorem ipsum",
  loading: "Lorem ipsum dolor",
  loadFailed: "Lorem ipsum dolor sit amet",
  errors: {
    noWebGl: "Lorem ipsum dolor sit amet, consectetur.",
    noFloatRendering: "Lorem ipsum dolor sit amet, adipiscing.",
  },
  player: {
    label: "Lorem ipsum",
    play: "Lorem",
    pause: "Ipsum",
    slower: "Dolor",
    faster: "Sit amet",
    reset: "Lorem ipsum",
    speedLabel: "Lorem ipsum",
  },
  /** Speed units, as shown in the readout: count, unit, then "per second". */
  speedUnits: {
    day: ["day", "days"],
    week: ["week", "weeks"],
    month: ["month", "months"],
    year: ["year", "years"],
  } satisfies Record<SpeedUnit, [string, string]>,
  perSecond: "/s",
  effectsToggle: "Lorem ipsum",
};
