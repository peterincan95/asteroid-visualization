import type { SpeedUnit } from "./time";

/**
 * Every string the app shows.
 */
export const COPY = {
  title: "Orbit Explorer",
  loading: "Loading orbits…",
  loadFailed: "The orbit data couldn't be loaded. Try refreshing the page.",
  errors: {
    noWebGl: "This browser doesn't support WebGL 2, which Orbit Explorer needs to draw the solar system.",
    noFloatRendering:
      "This device's graphics can't render the glow Orbit Explorer uses. Try another browser or device.",
  },
  player: {
    label: "Playback Controls",
    play: "Play",
    pause: "Pause",
    slower: "Slower",
    faster: "Faster",
    reset: "Reset Animation",
    speedLabel: "Playback Speed",
  },
  /** Speed units, as shown in the readout: count, unit, then "per second". */
  speedUnits: {
    day: ["day", "days"],
    week: ["week", "weeks"],
    month: ["month", "months"],
    year: ["year", "years"],
  } satisfies Record<SpeedUnit, [string, string]>,
  perSecond: "/s",
  effectsToggle: "Screen Effects",
};
