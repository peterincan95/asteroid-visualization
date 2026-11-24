import type { Ref } from "react";
import { COPY } from "./copy";
import { formatDate, SPEEDS, type Speed } from "./time";

interface Props {
  date: Date;
  isPlaying: boolean;
  speedIndex: number;
  onTogglePlay: () => void;
  onSpeedChange: (index: number) => void;
  onReset: () => void;
  /** Set while the player is drawn inside the plot (see hudPainter.ts) rather than shown as is. */
  isPainted: boolean;
  ref?: Ref<HTMLDivElement>;
}

const formatSpeed = ({ count, unit }: Speed) => {
  const [one, many] = COPY.speedUnits[unit];
  return `${count} ${Math.abs(count) === 1 ? one : many}${COPY.perSecond}`;
};

const Icon = ({ path }: { path: string }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path d={path} fill="currentColor" />
  </svg>
);

const ICONS = {
  play: "M7 4.5v15l13-7.5z",
  pause: "M6.5 5h4v14h-4zM13.5 5h4v14h-4z",
  slower: "M11.5 6v12L3 12zM21 6v12l-8.5-6z",
  faster: "M12.5 6v12l8.5-6zM3 6v12l8.5-6z",
  reset:
    "M12 5V1.5L7 6.5l5 5V8a5 5 0 1 1-5 5H4.5a7.5 7.5 0 1 0 7.5-7.5z",
};

// The first forward speed; ticks below it are reverse speeds.
const FIRST_FORWARD = SPEEDS.findIndex((speed) => speed.daysPerSecond > 0);

/** A meter of every speed, lit from the center (stopped) out to the current one. */
function SpeedMeter({ speedIndex }: { speedIndex: number }) {
  const isLit = (index: number) =>
    speedIndex >= FIRST_FORWARD
      ? index >= FIRST_FORWARD && index <= speedIndex
      : index < FIRST_FORWARD && index >= speedIndex;
  return (
    <div className="speed-meter" aria-hidden="true">
      {SPEEDS.map((speed, index) => (
        <span
          key={speed.daysPerSecond}
          className={[
            "speed-tick",
            isLit(index) ? "is-lit" : "",
            index === speedIndex ? "is-current" : "",
            index === FIRST_FORWARD ? "is-zero" : "",
          ].join(" ")}
        />
      ))}
    </div>
  );
}

/** Play controls along the bottom of the screen: date, transport buttons and speed. */
export function Player({ date, isPlaying, speedIndex, onTogglePlay, onSpeedChange, onReset, isPainted, ref }: Props) {
  const speed = SPEEDS[speedIndex]!;
  return (
    <div ref={ref} className={`player ${isPainted ? "is-painted" : ""}`} role="group" aria-label={COPY.player.label}>
      <div className="player-panel">
        <div className="player-readout">
          <span className={`player-light ${isPlaying ? "is-on" : ""}`} aria-hidden="true" />
          <span className="player-date">{formatDate(date)}</span>
        </div>
        <div className="player-divider" />
        <div className="player-buttons">
          <button type="button" className="player-button" aria-label={COPY.player.reset} onClick={onReset}>
            <Icon path={ICONS.reset} />
          </button>
          <button
            type="button"
            className="player-button"
            aria-label={COPY.player.slower}
            disabled={speedIndex === 0}
            onClick={() => onSpeedChange(speedIndex - 1)}
          >
            <Icon path={ICONS.slower} />
          </button>
          <button
            type="button"
            className={`player-button player-play ${isPlaying ? "is-playing" : ""}`}
            aria-label={isPlaying ? COPY.player.pause : COPY.player.play}
            onClick={onTogglePlay}
          >
            <Icon path={isPlaying ? ICONS.pause : ICONS.play} />
          </button>
          <button
            type="button"
            className="player-button"
            aria-label={COPY.player.faster}
            disabled={speedIndex === SPEEDS.length - 1}
            onClick={() => onSpeedChange(speedIndex + 1)}
          >
            <Icon path={ICONS.faster} />
          </button>
        </div>
        <div className="player-divider" />
        <div className="player-speed">
          <SpeedMeter speedIndex={speedIndex} />
          <output className="player-speed-text" aria-label={COPY.player.speedLabel}>
            {formatSpeed(speed)}
          </output>
        </div>
      </div>
    </div>
  );
}
