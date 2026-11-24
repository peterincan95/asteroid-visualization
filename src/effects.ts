/** Screen effects applied in the final pass, each with a strength from 0 to 1. */
export const EFFECT_IDS = [
  "chromaticAberration",
  "scanlines",
  "curvature",
  "vignette",
  "grain",
  "streaks",
  "flare",
  "starburst",
  "persistence",
  "phosphorMask",
  "flicker",
] as const;

export type EffectId = (typeof EFFECT_IDS)[number];

export interface EffectSetting {
  enabled: boolean;
  /** 0 to 1. */
  strength: number;
}

export type EffectSettings = Record<EffectId, EffectSetting>;

/** The display look. A strength stays set while its effect is off, for easy tuning here. */
export const DEFAULT_EFFECTS: EffectSettings = {
  chromaticAberration: { enabled: true, strength: 0.6 },
  scanlines: { enabled: true, strength: 0.32 },
  curvature: { enabled: true, strength: 0.11 },
  vignette: { enabled: true, strength: 0.56 },
  grain: { enabled: true, strength: 0.25 },
  streaks: { enabled: true, strength: 0.56 },
  flare: { enabled: true, strength: 0.27 },
  starburst: { enabled: false, strength: 0.31 },
  persistence: { enabled: false, strength: 1 },
  phosphorMask: { enabled: true, strength: 0.18 },
  flicker: { enabled: false, strength: 0.4 },
};

/** An effect's strength if it's on, else 0. */
export const effectAmount = (settings: EffectSettings, id: EffectId) =>
  settings[id].enabled ? settings[id].strength : 0;

/** Every effect off, for the plain view. */
export const NO_EFFECTS = Object.fromEntries(
  EFFECT_IDS.map((id) => [id, { ...DEFAULT_EFFECTS[id], enabled: false }]),
) as EffectSettings;

const STORAGE_KEY = "asteroid-visualization:effects-on";

/** Whether this browser last had the screen effects on; on by default. */
export function loadEffectsOn(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveEffectsOn(isOn: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, String(isOn));
  } catch {
    // Storage can be unavailable (private windows); the choice then lasts for the visit.
  }
}
