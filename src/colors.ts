import { PLANETS } from "./planets";

/**
 * Every body's color. Edit any line to recolor that family, planet or the Sun.
 *
 * Families start from their group's color. These colors haven't been checked
 * together for color-blind separation: in the current set, Hilda green and inner
 * orange are hard to tell apart with deuteranopia, though their positions differ.
 */
const GROUP_COLORS = {
  inner: "#e87d1a",
  mainBelt: "#b31e55",
  trojanHilda: "#10a36f",
  outer: "#6544ab",
  planet: "#f2eee6",
};

/** Asteroid families, by the names scripts/filter_asteroids.py gives them. */
export const FAMILY_COLORS: Record<string, string> = {
  // Inner solar system
  Atira: GROUP_COLORS.inner,
  Aten: GROUP_COLORS.inner,
  Apollo: GROUP_COLORS.inner,
  Amor: GROUP_COLORS.inner,
  "Inner (other)": GROUP_COLORS.inner,
  Hungaria: GROUP_COLORS.inner,
  "Mars-crosser": GROUP_COLORS.inner,

  // Main belt
  "Main belt inner": GROUP_COLORS.mainBelt,
  "Main belt middle": GROUP_COLORS.mainBelt,
  "Main belt outer": GROUP_COLORS.mainBelt,
  "Outer belt": GROUP_COLORS.mainBelt,

  // Trojans and Hildas
  Hilda: "#64b31e",
  Trojan: "#1eacb3",

  // Outer solar system
  Centaur: GROUP_COLORS.outer,
  TNO: GROUP_COLORS.outer,
  // Unclassified orbits, mostly eccentric ones beyond Jupiter.
  Other: GROUP_COLORS.outer,
};

export const PLANET_COLORS: Record<string, string> = {
  Mercury: GROUP_COLORS.planet,
  Venus: GROUP_COLORS.planet,
  Earth: GROUP_COLORS.planet,
  Mars: GROUP_COLORS.planet,
  Jupiter: GROUP_COLORS.planet,
  Saturn: GROUP_COLORS.planet,
  Uranus: GROUP_COLORS.planet,
  Neptune: GROUP_COLORS.planet,
};

export const SUN_COLOR = "#fff3d6";

// For a family or planet missing above.
const FALLBACK_COLOR = "#9a9a9a";

/**
 * The color table the renderer indexes by each body's color index: the asteroid
 * families in data order, then the planets in PLANETS order, then the Sun.
 */
export function colorTable(families: string[]): string[] {
  return [
    ...families.map((family) => FAMILY_COLORS[family] ?? FALLBACK_COLOR),
    ...PLANETS.map((planet) => PLANET_COLORS[planet.name] ?? FALLBACK_COLOR),
    SUN_COLOR,
  ];
}
