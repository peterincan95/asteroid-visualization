import { FLOATS_PER_ORBIT, writeOrbit } from "./data";

/**
 * Keplerian elements for the planets at J2000 and their rates per Julian century,
 * from JPL's "Approximate Positions of the Planets" (E. M. Standish), Table 1,
 * valid 1800–2050. Earth's row is the Earth-Moon barycenter.
 * Each: [value at J2000, rate per century] for a (AU), e, I, L, long. perihelion,
 * long. ascending node (degrees).
 */
type Rate = [number, number];
interface PlanetElements {
  name: string;
  diameterKm: number;
  a: Rate;
  e: Rate;
  i: Rate;
  meanLongitude: Rate;
  perihelionLongitude: Rate;
  node: Rate;
}

export const PLANETS: PlanetElements[] = [
  {
    name: "Mercury",
    diameterKm: 4879,
    a: [0.38709927, 0.00000037],
    e: [0.20563593, 0.00001906],
    i: [7.00497902, -0.00594749],
    meanLongitude: [252.2503235, 149472.67411175],
    perihelionLongitude: [77.45779628, 0.16047689],
    node: [48.33076593, -0.12534081],
  },
  {
    name: "Venus",
    diameterKm: 12104,
    a: [0.72333566, 0.0000039],
    e: [0.00677672, -0.00004107],
    i: [3.39467605, -0.0007889],
    meanLongitude: [181.9790995, 58517.81538729],
    perihelionLongitude: [131.60246718, 0.00268329],
    node: [76.67984255, -0.27769418],
  },
  {
    name: "Earth",
    diameterKm: 12742,
    a: [1.00000261, 0.00000562],
    e: [0.01671123, -0.00004392],
    i: [-0.00001531, -0.01294668],
    meanLongitude: [100.46457166, 35999.37244981],
    perihelionLongitude: [102.93768193, 0.32327364],
    node: [0, 0],
  },
  {
    name: "Mars",
    diameterKm: 6779,
    a: [1.52371034, 0.00001847],
    e: [0.0933941, 0.00007882],
    i: [1.84969142, -0.00813131],
    meanLongitude: [-4.55343205, 19140.30268499],
    perihelionLongitude: [-23.94362959, 0.44441088],
    node: [49.55953891, -0.29257343],
  },
  {
    name: "Jupiter",
    diameterKm: 139820,
    a: [5.202887, -0.00011607],
    e: [0.04838624, -0.00013253],
    i: [1.30439695, -0.00183714],
    meanLongitude: [34.39644051, 3034.74612775],
    perihelionLongitude: [14.72847983, 0.21252668],
    node: [100.47390909, 0.20469106],
  },
  {
    name: "Saturn",
    diameterKm: 116460,
    a: [9.53667594, -0.0012506],
    e: [0.05386179, -0.00050991],
    i: [2.48599187, 0.00193609],
    meanLongitude: [49.95424423, 1222.49362201],
    perihelionLongitude: [92.59887831, -0.41897216],
    node: [113.66242448, -0.28867794],
  },
  {
    name: "Uranus",
    diameterKm: 50724,
    a: [19.18916464, -0.00196176],
    e: [0.04725744, -0.00004397],
    i: [0.77263783, -0.00242939],
    meanLongitude: [313.23810451, 428.48202785],
    perihelionLongitude: [170.9542763, 0.40805281],
    node: [74.01692503, 0.04240589],
  },
  {
    name: "Neptune",
    diameterKm: 49244,
    a: [30.06992276, 0.00026291],
    e: [0.00859048, 0.00005105],
    i: [1.77004347, 0.00035372],
    meanLongitude: [-55.12002969, 218.45945325],
    perihelionLongitude: [44.96476227, -0.32241464],
    node: [131.78422574, -0.00508664],
  },
];

const SUN_DIAMETER_KM = 1_392_700;
const J2000_JD = 2451545.0;
const DAYS_PER_CENTURY = 36525;

/**
 * The planets' orbits, then the Sun (fixed at the center), in the same GPU layout
 * as the asteroids. Elements are taken at `days` from the reference epoch; the GPU
 * then moves each planet along that fixed ellipse, which stays accurate for decades
 * either side. Color indexes follow the asteroid families' (see colors.ts).
 */
export function bodyOrbits(days: number, referenceJd: number, familyCount: number): Float32Array {
  const centuries = (days + referenceJd - J2000_JD) / DAYS_PER_CENTURY;
  const at = ([value, rate]: Rate) => value + rate * centuries;
  const orbits = new Float32Array((PLANETS.length + 1) * FLOATS_PER_ORBIT);
  PLANETS.forEach((planet, index) => {
    const perihelionLongitude = at(planet.perihelionLongitude);
    const node = at(planet.node);
    writeOrbit(orbits, index, {
      a: at(planet.a),
      e: at(planet.e),
      i: at(planet.i),
      node,
      peri: perihelionLongitude - node,
      meanAnomaly: at(planet.meanLongitude) - perihelionLongitude,
      meanMotion: (planet.meanLongitude[1] * Math.PI) / 180 / DAYS_PER_CENTURY,
      epoch: days,
      diameterKm: planet.diameterKm,
      colorIndex: familyCount + index,
    });
  });
  writeOrbit(orbits, PLANETS.length, {
    a: 0,
    e: 0,
    i: 0,
    node: 0,
    peri: 0,
    meanAnomaly: 0,
    meanMotion: 0,
    epoch: days,
    diameterKm: SUN_DIAMETER_KM,
    colorIndex: familyCount + PLANETS.length,
  });
  return orbits;
}
