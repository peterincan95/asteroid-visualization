import { COPY } from "./copy";
import { formatDate, SPEEDS, type Speed } from "./time";

interface Props {
  date: Date;
  isPlaying: boolean;
  speedIndex: number;
  onTogglePlay: () => void;
  onSpeedChange: (index: number) => void;
  onToday: () => void;
}

const formatSpeed = ({ count, unit }: Speed) => {
  const [one, many] = COPY.speedUnits[unit];
  return `${count} ${Math.abs(count) === 1 ? one : many}${COPY.perSecond}`;
};

const Icon = ({ path }: { path: string }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <path d={path} fill="currentColor" />
  </svg>
);

const ICONS = {
  play: "M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z",
  pause: "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z",
  slower: "M11 6.5v11L3.5 12zM20 6.5v11L12.5 12z",
  faster: "M13 6.5v11l7.5-5.5zM4 6.5v11l7.5-5.5z",
};

/** Play controls along the bottom of the screen: date, play/pause and speed. */
export function Player({ date, isPlaying, speedIndex, onTogglePlay, onSpeedChange, onToday }: Props) {
  const speed = SPEEDS[speedIndex]!;
  return (
    <div className="player" role="group" aria-label={COPY.player.label}>
      <button type="button" className="player-date" onClick={onToday} title={COPY.player.todayHint}>
        {formatDate(date)}
      </button>
      <div className="player-divider" />
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
        className="player-button player-play"
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
      <div className="player-divider" />
      <output className="player-speed" aria-label={COPY.player.speedLabel}>
        {formatSpeed(speed)}
      </output>
    </div>
  );
}
