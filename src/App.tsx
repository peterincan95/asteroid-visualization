import { useEffect, useMemo, useRef, useState } from "react";
import { COPY } from "./copy";
import { loadOrbits, type OrbitData } from "./data";
import { DEFAULT_EFFECTS, loadEffectsOn, NO_EFFECTS, saveEffectsOn } from "./effects";
import { HudPainter, isPlayerAnimated, paintFilters, paintPlayer } from "./hudPainter";
import { FilterPanel } from "./FilterPanel";
import { filterScales, FULL_POSITIONS, toOrbitFilter, type FilterPositions } from "./filters";
import { PanZoom } from "./panZoom";
import { colorTable } from "./colors";
import { bodyOrbits } from "./planets";
import { Player } from "./Player";
import { OrbitRenderer } from "./renderer";
import { dateAt, daysAt, DEFAULT_SPEED_INDEX, SPEEDS } from "./time";

// Longest step one frame may advance, in seconds, so a hidden tab doesn't jump on return.
const MAX_FRAME_SECONDS = 0.1;

export function App() {
  const [data, setData] = useState<OrbitData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadOrbits().then(setData, (reason: unknown) => {
      console.error(reason);
      setError(COPY.loadFailed);
    });
  }, []);

  if (error) return <div className="status">{error}</div>;
  if (!data) return <div className="status">{COPY.loading}</div>;
  return <Visualization data={data} />;
}

function Visualization({ data }: { data: OrbitData }) {
  const { referenceJd } = data.meta;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const filtersRef = useRef<HTMLElement>(null);
  const [isPainted, setIsPainted] = useState(false);
  const rendererRef = useRef<OrbitRenderer | null>(null);
  const daysRef = useRef(daysAt(new Date(), referenceJd));
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [speedIndex, setSpeedIndex] = useState(DEFAULT_SPEED_INDEX);
  const [effectsOn, setEffectsOn] = useState(loadEffectsOn);
  const effectsOnRef = useRef(effectsOn);
  const scales = useMemo(() => filterScales(data.orbits, data.count), [data]);
  const [filterPositions, setFilterPositions] = useState<FilterPositions>(FULL_POSITIONS);
  const filterRef = useRef(toOrbitFilter(filterPositions, scales));
  // The date shown in the player, updated once per simulated day.
  const [shownDay, setShownDay] = useState(() => Math.floor(daysRef.current));

  // Renderer, resizing and pan/zoom.
  useEffect(() => {
    const canvas = canvasRef.current!;
    let renderer: OrbitRenderer;
    try {
      const { families } = data.meta;
      const bodies = bodyOrbits(daysRef.current, referenceJd, families.length);
      renderer = new OrbitRenderer(canvas, data, bodies, colorTable(families), COPY.errors);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    rendererRef.current = renderer;
    renderer.setTime(daysRef.current);
    renderer.setEffects(effectsOnRef.current ? DEFAULT_EFFECTS : NO_EFFECTS);
    renderer.setFilter(filterRef.current);
    const observer = new ResizeObserver(() => {
      const { width, height } = canvas.getBoundingClientRect();
      renderer.setLayout(width, height);
    });
    observer.observe(canvas);
    const panZoom = new PanZoom(canvas, (camera) => renderer.setCamera(camera));
    // The UI panels are painted into the plot so the screen effects reach them too.
    const painters = [
      new HudPainter(playerRef.current!, canvas, paintPlayer, (source, rect) => renderer.setOverlay(0, source, rect), isPlayerAnimated),
      new HudPainter(filtersRef.current!, canvas, paintFilters, (source, rect) => renderer.setOverlay(1, source, rect)),
    ];
    setIsPainted(true);
    return () => {
      for (const painter of painters) painter.destroy();
      setIsPainted(false);
      observer.disconnect();
      panZoom.destroy();
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [data]);

  // Screen effects, kept for the next visit.
  useEffect(() => {
    effectsOnRef.current = effectsOn;
    rendererRef.current?.setEffects(effectsOn ? DEFAULT_EFFECTS : NO_EFFECTS);
    saveEffectsOn(effectsOn);
  }, [effectsOn]);

  // Which asteroids are shown.
  useEffect(() => {
    filterRef.current = toOrbitFilter(filterPositions, scales);
    rendererRef.current?.setFilter(filterRef.current);
  }, [filterPositions, scales]);

  // The clock.
  useEffect(() => {
    if (!isPlaying) return;
    const daysPerSecond = SPEEDS[speedIndex]!.daysPerSecond;
    let previous = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const seconds = Math.min((now - previous) / 1000, MAX_FRAME_SECONDS);
      previous = now;
      daysRef.current += daysPerSecond * seconds;
      rendererRef.current?.setTime(daysRef.current);
      setShownDay(Math.floor(daysRef.current));
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [isPlaying, speedIndex]);

  // Space toggles playback.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.target instanceof HTMLButtonElement || event.target instanceof HTMLInputElement) return;
      event.preventDefault();
      setIsPlaying((playing) => !playing);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Restarts the simulation from the present moment and plays it.
  const reset = () => {
    daysRef.current = daysAt(new Date(), referenceJd);
    rendererRef.current?.setTime(daysRef.current);
    setShownDay(Math.floor(daysRef.current));
    setIsPlaying(true);
  };

  return (
    <main className="app">
      <canvas ref={canvasRef} className="plot" />
      {error && <div className="status">{error}</div>}
      <button
        type="button"
        className="effects-toggle"
        aria-label={COPY.effectsToggle}
        aria-pressed={effectsOn}
        onClick={() => setEffectsOn((on) => !on)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M4 5.5h16v11H4zM9 20h6M12 16.5V20" stroke="currentColor" strokeWidth="1.6" fill="none" />
          <path d="M7.5 9.5h9M7.5 12.5h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      <FilterPanel
        scales={scales}
        positions={filterPositions}
        onChange={setFilterPositions}
        isPainted={isPainted}
        ref={filtersRef}
      />
      <Player
        date={dateAt(shownDay, referenceJd)}
        isPlaying={isPlaying}
        speedIndex={speedIndex}
        onTogglePlay={() => setIsPlaying((playing) => !playing)}
        onSpeedChange={setSpeedIndex}
        onReset={reset}
        isPainted={isPainted}
        ref={playerRef}
      />
    </main>
  );
}
