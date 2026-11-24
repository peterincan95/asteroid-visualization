import { useEffect, useRef, useState } from "react";
import { COPY } from "./copy";
import { loadOrbits, type OrbitData } from "./data";
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
  const rendererRef = useRef<OrbitRenderer | null>(null);
  const daysRef = useRef(daysAt(new Date(), referenceJd));
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [speedIndex, setSpeedIndex] = useState(DEFAULT_SPEED_INDEX);
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
    const observer = new ResizeObserver(() => {
      const { width, height } = canvas.getBoundingClientRect();
      renderer.setLayout(width, height);
    });
    observer.observe(canvas);
    const panZoom = new PanZoom(canvas, (camera) => renderer.setCamera(camera));
    return () => {
      observer.disconnect();
      panZoom.destroy();
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [data]);

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
      if (event.code !== "Space" || event.target instanceof HTMLButtonElement) return;
      event.preventDefault();
      setIsPlaying((playing) => !playing);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const goToToday = () => {
    daysRef.current = daysAt(new Date(), referenceJd);
    rendererRef.current?.setTime(daysRef.current);
    setShownDay(Math.floor(daysRef.current));
  };

  return (
    <main className="app">
      <canvas ref={canvasRef} className="plot" />
      {error && <div className="status">{error}</div>}
      <Player
        date={dateAt(shownDay, referenceJd)}
        isPlaying={isPlaying}
        speedIndex={speedIndex}
        onTogglePlay={() => setIsPlaying((playing) => !playing)}
        onSpeedChange={setSpeedIndex}
        onToday={goToToday}
      />
    </main>
  );
}
