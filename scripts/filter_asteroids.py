"""Filter the full JPL asteroid export down to a ~15k display set.

Usage (from the project root):
    python scripts/filter_asteroids.py [input.csv] [output folder]

Each asteroid is assigned a display family (JPL orbit class, with the main belt
split at the Kirkwood gaps and Hungaria/Hilda groups pulled out). A per-family
minimum diameter then decides what is kept. Measured diameters are used where
JPL has them; otherwise diameter is estimated from H using the median measured
albedo of that family.

Writes two files for the web app:
    asteroids.bin   little-endian float32, FIELDS values per asteroid
    asteroids.json  count, field order, reference epoch and family names
"""

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_IN = ROOT / "data" / "all-asteroids.csv"
DEFAULT_OUT = ROOT / "public" / "data"

# Epochs are stored as days from this Julian date, so they fit in float32.
REFERENCE_JD = 2461200.5

# Values written per asteroid, in order. Angles in degrees, a in AU, D in km.
FIELDS = ["a", "e", "i", "om", "w", "ma", "epoch_days", "D", "family_index"]

# Drop poorly determined orbits (JPL uncertainty parameter, 0 = best, 9 = worst).
MAX_CONDITION_CODE = 5
# How many of the largest named asteroids get labels in the app.
LABEL_COUNT = 50

# Minimum diameter in km per display family. 0 keeps everything that passes
# the orbit-quality filter.
MIN_DIAMETER_KM = {
    "Atira": 0,
    "Aten": 0.5,
    "Apollo": 0.5,
    "Amor": 0.5,
    "Inner (other)": 1,
    "Hungaria": 2,
    "Mars-crosser": 3,
    "Main belt inner": 11,
    "Main belt middle": 11,
    "Main belt outer": 11,
    "Outer belt": 13,
    "Hilda": 6,
    "Trojan": 11,
    "Centaur": 10,
    "TNO": 250,
    "Other": 5,
}

# Albedo used to estimate diameter when a family has too few measurements.
FALLBACK_ALBEDO = {"Atira": 0.14, "TNO": 0.09, "Other": 0.10}
DEFAULT_ALBEDO = 0.14
MIN_ALBEDO_SAMPLES = 30


def assign_family(df: pd.DataFrame) -> pd.Series:
    a, e, i, cls = df["a"], df["e"], df["i"], df["class"]
    conditions = [
        cls == "IEO",
        cls == "ATE",
        cls == "APO",
        cls == "AMO",
        cls == "MCA",
        (cls == "IMB") & a.between(1.78, 2.0) & (e < 0.18) & i.between(16, 34),
        cls == "IMB",
        (cls == "MBA") & (a < 2.5),
        (cls == "MBA") & (a < 2.82),
        cls == "MBA",
        (cls == "OMB") & a.between(3.7, 4.2) & (e < 0.3) & (i < 20),
        cls == "OMB",
        cls == "TJN",
        cls == "CEN",
        cls == "TNO",
    ]
    names = [
        "Atira", "Aten", "Apollo", "Amor", "Mars-crosser", "Hungaria",
        "Inner (other)", "Main belt inner", "Main belt middle",
        "Main belt outer", "Hilda", "Outer belt", "Trojan", "Centaur", "TNO",
    ]
    return pd.Series(np.select(conditions, names, "Other"), index=df.index)


def family_albedos(df: pd.DataFrame) -> dict:
    stats = df.groupby("family")["albedo"].agg(["count", "median"])
    albedos = {}
    for fam in MIN_DIAMETER_KM:
        if fam in stats.index and stats.loc[fam, "count"] >= MIN_ALBEDO_SAMPLES:
            albedos[fam] = float(stats.loc[fam, "median"])
        else:
            albedos[fam] = FALLBACK_ALBEDO.get(fam, DEFAULT_ALBEDO)
    return albedos


def main(src: Path, dst: Path) -> None:
    df = pd.read_csv(src, low_memory=False)
    total = len(df)

    df = df.dropna(subset=["a", "e", "i", "om", "w", "ma", "epoch", "H"])
    df = df[pd.to_numeric(df["condition_code"], errors="coerce") <= MAX_CONDITION_CODE]

    df["family"] = assign_family(df)
    albedos = family_albedos(df)
    p = df["family"].map(albedos)
    estimated = 1329.0 / np.sqrt(p) * 10 ** (-df["H"] / 5)
    df["d_estimated"] = df["diameter"].isna()
    df["D"] = df["diameter"].fillna(estimated)

    keep = df["D"] >= df["family"].map(MIN_DIAMETER_KM)
    out = df[keep].copy()
    families = list(MIN_DIAMETER_KM)
    out["epoch_days"] = out["epoch"] - REFERENCE_JD
    out["family_index"] = out["family"].map({f: n for n, f in enumerate(families)})

    dst.mkdir(parents=True, exist_ok=True)
    bin_path = dst / "asteroids.bin"
    out[FIELDS].to_numpy(dtype="<f4").tofile(bin_path)
    # The largest named asteroids get labels: their index in the binary file and name.
    named = out.reset_index(drop=True)
    named = named[named["name"].notna() & (named["name"].astype(str).str.strip() != "")]
    largest = named.sort_values("D", ascending=False).head(LABEL_COUNT)
    labels = [{"index": int(index), "name": str(row["name"]).strip()} for index, row in largest.iterrows()]
    meta = {
        "count": len(out),
        "fields": FIELDS,
        "referenceJd": REFERENCE_JD,
        "families": families,
        "labels": labels,
    }
    with open(dst / "asteroids.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    summary = pd.DataFrame({
        "min_D_km": pd.Series(MIN_DIAMETER_KM),
        "albedo": pd.Series(albedos),
        "passed_quality": df["family"].value_counts(),
        "kept": out["family"].value_counts(),
    }).fillna(0)
    summary[["passed_quality", "kept"]] = summary[["passed_quality", "kept"]].astype(int)
    print(f"Input rows: {total:,}")
    print(summary.sort_values("kept", ascending=False).to_string())
    print(f"\nKept {len(out):,} asteroids -> {bin_path} ({bin_path.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_IN
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUT
    main(src, dst)
