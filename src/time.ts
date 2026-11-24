const UNIX_EPOCH_JD = 2440587.5;
const DAY_MS = 86_400_000;

/** Days from the data's reference epoch at a moment. */
export const daysAt = (date: Date, referenceJd: number) => date.getTime() / DAY_MS + UNIX_EPOCH_JD - referenceJd;

/** The moment `days` after the data's reference epoch. */
export const dateAt = (days: number, referenceJd: number) =>
  new Date((days + referenceJd - UNIX_EPOCH_JD) * DAY_MS);

export type SpeedUnit = "day" | "week" | "month" | "year";

/** Playback speeds in simulated days per real second, each shown as a count of a unit. */
export interface Speed {
  daysPerSecond: number;
  count: number;
  unit: SpeedUnit;
}

const FORWARD: Speed[] = [
  { daysPerSecond: 1, count: 1, unit: "day" },
  { daysPerSecond: 7, count: 1, unit: "week" },
  { daysPerSecond: 30.4375, count: 1, unit: "month" },
  { daysPerSecond: 91.3125, count: 3, unit: "month" },
  { daysPerSecond: 182.625, count: 6, unit: "month" },
  { daysPerSecond: 365.25, count: 1, unit: "year" },
  { daysPerSecond: 1826.25, count: 5, unit: "year" },
];

/** Slowest reverse to fastest forward. */
export const SPEEDS: Speed[] = [
  ...FORWARD.map((speed) => ({ ...speed, daysPerSecond: -speed.daysPerSecond, count: -speed.count })).reverse(),
  ...FORWARD,
];

/** One month per second. */
export const DEFAULT_SPEED_INDEX = SPEEDS.findIndex((speed) => speed.unit === "month" && speed.count === 1);

const dateFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export const formatDate = (date: Date) => dateFormat.format(date);
