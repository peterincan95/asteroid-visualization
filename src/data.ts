/** What scripts/filter_asteroids.py writes alongside asteroids.bin. */
export interface Meta {
  count: number;
  fields: string[];
  referenceJd: number;
  families: string[];
}

/**
 * Orbits ready for the GPU, FLOATS_PER_ORBIT per body:
 * P.x, P.y, Q.x, Q.y (the orbit's axes flattened onto the ecliptic),
 * a (AU), e, mean anomaly at epoch (rad), mean motion (rad/day),
 * epoch (days from the reference), log10 diameter (km), color index (see colors.ts).
 */
export interface OrbitData {
  meta: Meta;
  count: number;
  orbits: Float32Array;
  family: Uint8Array;
}

export const FLOATS_PER_ORBIT = 11;

// Gaussian gravitational constant: mean motion in rad/day for a = 1 AU.
const GAUSS_K = 0.01720209895;
export const RADIANS = Math.PI / 180;
const REQUIRED_FIELDS = ["a", "e", "i", "om", "w", "ma", "epoch_days", "D", "family_index"];

export interface Elements {
  /** Semi-major axis, AU. */
  a: number;
  e: number;
  /** Inclination, longitude of the ascending node and argument of perihelion, degrees. */
  i: number;
  node: number;
  peri: number;
  /** Mean anomaly at the epoch, degrees. */
  meanAnomaly: number;
  /** Mean motion, rad/day. */
  meanMotion: number;
  /** Days from the reference epoch. */
  epoch: number;
  diameterKm: number;
  /** Index into the color table from colors.ts. */
  colorIndex: number;
}

/** Writes one body's orbit into `orbits` at `index`, in the layout of OrbitData. */
export function writeOrbit(orbits: Float32Array, index: number, el: Elements) {
  const i = el.i * RADIANS;
  const node = el.node * RADIANS;
  const peri = el.peri * RADIANS;
  const [cosNode, sinNode, cosPeri, sinPeri, cosI] = [
    Math.cos(node),
    Math.sin(node),
    Math.cos(peri),
    Math.sin(peri),
    Math.cos(i),
  ];
  const out = index * FLOATS_PER_ORBIT;
  orbits[out] = cosPeri * cosNode - sinPeri * sinNode * cosI;
  orbits[out + 1] = cosPeri * sinNode + sinPeri * cosNode * cosI;
  orbits[out + 2] = -sinPeri * cosNode - cosPeri * sinNode * cosI;
  orbits[out + 3] = -sinPeri * sinNode + cosPeri * cosNode * cosI;
  orbits[out + 4] = el.a;
  orbits[out + 5] = el.e;
  orbits[out + 6] = el.meanAnomaly * RADIANS;
  orbits[out + 7] = el.meanMotion;
  orbits[out + 8] = el.epoch;
  orbits[out + 9] = Math.log10(Math.max(el.diameterKm, 1e-3));
  orbits[out + 10] = el.colorIndex;
}

export async function loadOrbits(): Promise<OrbitData> {
  const base = `${import.meta.env.BASE_URL}data/`;
  const [meta, buffer] = await Promise.all([
    fetch(`${base}asteroids.json`).then((response) => {
      if (!response.ok) throw new Error(`asteroids.json: ${response.status}`);
      return response.json() as Promise<Meta>;
    }),
    fetch(`${base}asteroids.bin`).then((response) => {
      if (!response.ok) throw new Error(`asteroids.bin: ${response.status}`);
      return response.arrayBuffer();
    }),
  ]);

  const stride = meta.fields.length;
  const column = Object.fromEntries(REQUIRED_FIELDS.map((name) => [name, meta.fields.indexOf(name)]));
  if (Object.values(column).some((index) => index < 0)) throw new Error("asteroids.json is missing fields");
  const raw = new Float32Array(buffer);
  const count = Math.min(meta.count, Math.floor(raw.length / stride));
  const orbits = new Float32Array(count * FLOATS_PER_ORBIT);
  const family = new Uint8Array(count);

  for (let index = 0; index < count; index += 1) {
    const at = (name: string) => raw[index * stride + column[name]!]!;
    const a = at("a");
    family[index] = at("family_index");
    writeOrbit(orbits, index, {
      a,
      e: at("e"),
      i: at("i"),
      node: at("om"),
      peri: at("w"),
      meanAnomaly: at("ma"),
      meanMotion: GAUSS_K / Math.pow(a, 1.5),
      epoch: at("epoch_days"),
      diameterKm: at("D"),
      colorIndex: family[index]!,
    });
  }
  return { meta, count, orbits, family };
}
