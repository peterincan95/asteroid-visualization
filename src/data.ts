/** What scripts/filter_asteroids.py writes alongside asteroids.bin. */
export interface Meta {
  count: number;
  fields: string[];
  referenceJd: number;
  families: string[];
}

/**
 * Orbits ready for the GPU, FLOATS_PER_ORBIT per asteroid:
 * P.x, P.y, Q.x, Q.y (the orbit's axes flattened onto the ecliptic),
 * a (AU), e, mean anomaly at epoch (rad), mean motion (rad/day),
 * epoch (days from the reference), log10 diameter (km).
 */
export interface OrbitData {
  meta: Meta;
  count: number;
  orbits: Float32Array;
  family: Uint8Array;
}

export const FLOATS_PER_ORBIT = 10;
// Gaussian gravitational constant: mean motion in rad/day for a = 1 AU.
const GAUSS_K = 0.01720209895;
const RADIANS = Math.PI / 180;
const REQUIRED_FIELDS = ["a", "e", "i", "om", "w", "ma", "epoch_days", "D", "family_index"];

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
    const i = at("i") * RADIANS;
    const node = at("om") * RADIANS;
    const peri = at("w") * RADIANS;
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
    orbits[out + 4] = a;
    orbits[out + 5] = at("e");
    orbits[out + 6] = at("ma") * RADIANS;
    orbits[out + 7] = GAUSS_K / Math.pow(a, 1.5);
    orbits[out + 8] = at("epoch_days");
    orbits[out + 9] = Math.log10(Math.max(at("D"), 1e-3));
    family[index] = at("family_index");
  }
  return { meta, count, orbits, family };
}
