import { MAX_ZOOM, PLOT_FILL, type Camera } from "./renderer";

export const HOME: Camera = { zoom: 1, x: 0, y: 0 };
// The camera's center stays within this distance of the Sun, in plot units (edge = 1).
const MAX_CENTER_DISTANCE = 1.1;
// Zoom change per pixel of wheel movement. Trackpad pinches report far smaller steps.
const WHEEL_SPEED = 0.002;
const PINCH_WHEEL_SPEED = 0.012;
const LINE_HEIGHT_PIXELS = 16;

interface Pointer {
  x: number;
  y: number;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Wheel, drag and pinch control of the plot's camera. */
export class PanZoom {
  camera = HOME;
  private pointers = new Map<number, Pointer>();

  constructor(
    private element: HTMLElement,
    private onChange: (camera: Camera) => void,
  ) {
    element.addEventListener("wheel", this.onWheel, { passive: false });
    element.addEventListener("pointerdown", this.onPointerDown);
    element.addEventListener("pointermove", this.onPointerMove);
    element.addEventListener("pointerup", this.onPointerEnd);
    element.addEventListener("pointercancel", this.onPointerEnd);
  }

  destroy() {
    this.element.removeEventListener("wheel", this.onWheel);
    this.element.removeEventListener("pointerdown", this.onPointerDown);
    this.element.removeEventListener("pointermove", this.onPointerMove);
    this.element.removeEventListener("pointerup", this.onPointerEnd);
    this.element.removeEventListener("pointercancel", this.onPointerEnd);
  }

  private pixelsPerUnit(zoom: number) {
    const { width, height } = this.element.getBoundingClientRect();
    return (Math.min(width, height) / 2) * PLOT_FILL * zoom;
  }

  /** The plot position under a point in the element, in CSS pixels. */
  private plotAt(x: number, y: number, camera = this.camera): Pointer {
    const { width, height } = this.element.getBoundingClientRect();
    const scale = this.pixelsPerUnit(camera.zoom);
    return { x: camera.x + (x - width / 2) / scale, y: camera.y - (y - height / 2) / scale };
  }

  private set(camera: Camera) {
    const zoom = clamp(camera.zoom, HOME.zoom, MAX_ZOOM);
    let { x, y } = camera;
    const distance = Math.hypot(x, y);
    if (distance > MAX_CENTER_DISTANCE) {
      x *= MAX_CENTER_DISTANCE / distance;
      y *= MAX_CENTER_DISTANCE / distance;
    }
    if (zoom === HOME.zoom) {
      x = 0;
      y = 0;
    }
    this.camera = { zoom, x, y };
    this.onChange(this.camera);
  }

  /** Zooms by `factor`, keeping the plot position under (x, y) in place. */
  private zoomAround(x: number, y: number, factor: number) {
    const before = this.plotAt(x, y);
    const zoom = clamp(this.camera.zoom * factor, HOME.zoom, MAX_ZOOM);
    const { width, height } = this.element.getBoundingClientRect();
    const scale = this.pixelsPerUnit(zoom);
    this.set({ zoom, x: before.x - (x - width / 2) / scale, y: before.y + (y - height / 2) / scale });
  }

  private local(event: PointerEvent | WheelEvent): Pointer {
    const rect = this.element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const pixels = event.deltaMode === 1 ? event.deltaY * LINE_HEIGHT_PIXELS : event.deltaY;
    const speed = event.ctrlKey ? PINCH_WHEEL_SPEED : WHEEL_SPEED;
    const { x, y } = this.local(event);
    this.zoomAround(x, y, Math.exp(-pixels * speed));
  };

  private onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    this.element.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, this.local(event));
  };

  private onPointerMove = (event: PointerEvent) => {
    const previous = this.pointers.get(event.pointerId);
    if (!previous) return;
    const current = this.local(event);
    const others = [...this.pointers.entries()].filter(([id]) => id !== event.pointerId);
    const other = others[0]?.[1];
    if (other) {
      // Pinch: zoom by the change in finger spread, around their midpoint.
      const before = Math.hypot(previous.x - other.x, previous.y - other.y);
      const after = Math.hypot(current.x - other.x, current.y - other.y);
      if (before > 0) this.zoomAround((current.x + other.x) / 2, (current.y + other.y) / 2, after / before);
    }
    const scale = this.pixelsPerUnit(this.camera.zoom) * (other ? 2 : 1);
    this.set({
      zoom: this.camera.zoom,
      x: this.camera.x - (current.x - previous.x) / scale,
      y: this.camera.y + (current.y - previous.y) / scale,
    });
    this.pointers.set(event.pointerId, current);
  };

  private onPointerEnd = (event: PointerEvent) => {
    this.pointers.delete(event.pointerId);
  };
}
