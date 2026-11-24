# Asteroid Visualization

An animated, top-down WebGL view of about 15,000 asteroids orbiting the Sun.
Vite + React + TypeScript, with plain WebGL2 and no 3D library.

## Running

```
npm install
npm run dev
```

## How it works

- **Orbits** are propagated on the GPU. Each frame, every asteroid's position is
  solved from its orbital elements (two-body Kepler motion, no planetary
  perturbations) and flattened onto the ecliptic.
- **Distance** from the Sun is drawn on a log scale,
  `ln(1 + r / 0.13 AU) / ln(1 + 60 AU / 0.13 AU)`, which puts the main belt
  about halfway to the edge. The constants are in `src/renderer.ts`.
- **Points** add into a density buffer that is toned and given a two-size glow,
  the same pipeline as the UCDP and NYC 311 explorers. Point width grows with
  the log of diameter.
- **Trails** reach back `TRAIL_DAYS` (60) along each orbit and fade toward the
  tail. They're drawn as their own pale layer and don't feed the glow.

## Data

`public/data/asteroids.bin` and `asteroids.json` are built from a JPL Small-Body
Database export by `scripts/filter_asteroids.py`. The export is too big for git,
so to rebuild:

1. Download all asteroids from the
   [SBDB Query tool](https://ssd.jpl.nasa.gov/tools/sbdb_query.html) as CSV with
   these fields: `full_name, a, e, i, om, w, q, ad, per_y, data_arc,
   condition_code, n_obs_used, n_del_obs_used, n_dop_obs_used, H, diameter,
   spkid, pdes, name, prefix, albedo, epoch, ma, class`.
2. Save it as `data/all-asteroids.csv`.
3. Run `python scripts/filter_asteroids.py`. It needs pandas and numpy.

The script drops orbits with condition code above 5 and assigns each asteroid a
display family. It keeps those above a minimum diameter set per family in
`MIN_DIAMETER_KM`. Missing diameters are estimated from H using the family's
median measured albedo.
