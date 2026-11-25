/**
 * Pointer input for the painted UI panels. The panels are drawn through the screen
 * curvature, so what you see sits a little away from where the (invisible) HTML is. The
 * HTML stops taking pointer events while painted; this maps each pointer position back
 * through the curvature to the spot it shows, and hovers, presses and drags the control
 * there. Keyboard input still goes straight to the HTML.
 */

interface Point {
  x: number;
  y: number;
}

/** A thumb being dragged: its input, and how far the grab point sits from its center. */
interface Drag {
  pointerId: number;
  input: HTMLInputElement;
  offset: number;
}

/** A button being pressed. */
interface Press {
  pointerId: number;
  button: HTMLButtonElement;
}

// Extra room around a slider thumb that still grabs it, in CSS pixels.
const THUMB_SLOP = 4;

const HOVER = "data-hover";
const ACTIVE = "data-active";

/** Sets a React-controlled input's value as typing would, so its onChange runs. */
function setInputValue(input: HTMLInputElement, value: number) {
  if (Number(input.value) === value) return;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(value));
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const contains = (r: DOMRect, { x, y }: Point) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

export class PanelPointer {
  private hovered: HTMLElement | null = null;
  private drag: Drag | null = null;
  private press: Press | null = null;

  constructor(
    private plot: HTMLCanvasElement,
    private panels: HTMLElement[],
    /** Where a point on the plot (CSS pixels from its top left) shows on the undistorted UI. */
    private toSource: (x: number, y: number) => Point,
  ) {
    window.addEventListener("pointerdown", this.onDown, true);
    window.addEventListener("pointermove", this.onMove, true);
    window.addEventListener("pointerup", this.onUp, true);
    window.addEventListener("pointercancel", this.onCancel, true);
    window.addEventListener("wheel", this.onWheel, { capture: true, passive: false });
    document.addEventListener("pointerleave", this.onLeave);
  }

  destroy() {
    window.removeEventListener("pointerdown", this.onDown, true);
    window.removeEventListener("pointermove", this.onMove, true);
    window.removeEventListener("pointerup", this.onUp, true);
    window.removeEventListener("pointercancel", this.onCancel, true);
    window.removeEventListener("wheel", this.onWheel, true);
    document.removeEventListener("pointerleave", this.onLeave);
    this.setHovered(null);
    this.plot.style.cursor = "";
  }

  /** The event's position as shown on the undistorted UI, in client coordinates. */
  private source(event: MouseEvent): Point {
    const box = this.plot.getBoundingClientRect();
    const point = this.toSource(event.clientX - box.left, event.clientY - box.top);
    return { x: point.x + box.left, y: point.y + box.top };
  }

  private panelAt(point: Point) {
    return this.panels.find((panel) => panel.classList.contains("is-painted") && contains(panel.getBoundingClientRect(), point));
  }

  /** The button or slider under a point in a panel. */
  private controlAt(panel: HTMLElement, point: Point): HTMLElement | null {
    for (const button of panel.querySelectorAll("button")) {
      if (!button.disabled && contains(button.getBoundingClientRect(), point)) return button;
    }
    for (const range of panel.querySelectorAll<HTMLElement>(".filter-range")) {
      if (contains(range.getBoundingClientRect(), point)) return range;
    }
    return null;
  }

  /** A slider's thumb geometry: where its values start, how far they run, and the thumb size. */
  private track(range: HTMLElement) {
    const box = range.getBoundingClientRect();
    const thumb = parseFloat(getComputedStyle(range).getPropertyValue("--thumb")) || 10;
    return { start: box.left + thumb / 2, span: box.width - thumb, thumb };
  }

  private thumbX(range: HTMLElement, input: HTMLInputElement) {
    const { start, span } = this.track(range);
    return start + (span * Number(input.value)) / Number(input.max);
  }

  private valueAt(input: HTMLInputElement, x: number) {
    const range = input.parentElement!;
    const { start, span } = this.track(range);
    const share = Math.min(Math.max((x - start) / span, 0), 1);
    return Math.round(share * Number(input.max));
  }

  private setHovered(element: HTMLElement | null) {
    if (element === this.hovered) return;
    this.hovered?.removeAttribute(HOVER);
    element?.setAttribute(HOVER, "");
    this.hovered = element;
  }

  /** Updates hover and the cursor for a pointer at a source point. */
  private hover(point: Point) {
    const panel = this.panelAt(point);
    const control = panel ? this.controlAt(panel, point) : null;
    this.setHovered(control instanceof HTMLButtonElement ? control : null);
    this.plot.style.cursor = this.drag || control ? "pointer" : panel ? "default" : "";
  }

  private onDown = (event: PointerEvent) => {
    if (this.drag || this.press) {
      // A second finger while one is busy with a control: ignore it.
      event.stopPropagation();
      return;
    }
    const point = this.source(event);
    const panel = this.panelAt(point);
    if (!panel) return;
    // Over a panel, the plot doesn't pan.
    event.stopPropagation();
    event.preventDefault();
    if (event.button !== 0) return;
    const control = this.controlAt(panel, point);
    if (control instanceof HTMLButtonElement) {
      this.press = { pointerId: event.pointerId, button: control };
      control.setAttribute(ACTIVE, "");
    } else if (control) {
      this.grab(control, point, event.pointerId);
    }
    this.hover(point);
  };

  /** Starts dragging the nearest thumb; a press off both thumbs moves the nearest one there. */
  private grab(range: HTMLElement, point: Point, pointerId: number) {
    const inputs = [...range.querySelectorAll("input")];
    if (inputs.length === 0) return;
    const { thumb } = this.track(range);
    const distances = inputs.map((input) => point.x - this.thumbX(range, input));
    // Nearest thumb; when they overlap, the one on the side being pressed toward.
    let index = 0;
    for (let i = 1; i < inputs.length; i += 1) {
      const [best, next] = [Math.abs(distances[index]!), Math.abs(distances[i]!)];
      if (next < best || (next === best && distances[i]! > 0)) index = i;
    }
    const input = inputs[index]!;
    const onThumb = Math.abs(distances[index]!) <= thumb / 2 + THUMB_SLOP;
    this.drag = { pointerId, input, offset: onThumb ? distances[index]! : 0 };
    if (!onThumb) setInputValue(input, this.valueAt(input, point.x));
  }

  private onMove = (event: PointerEvent) => {
    const point = this.source(event);
    const { drag, press } = this;
    if (drag) {
      if (event.pointerId !== drag.pointerId) return;
      event.stopPropagation();
      setInputValue(drag.input, this.valueAt(drag.input, point.x - drag.offset));
      return;
    }
    if (press) {
      if (event.pointerId !== press.pointerId) return;
      event.stopPropagation();
      // Pressed only while still over the button, as with a real one.
      const isOver = contains(press.button.getBoundingClientRect(), point);
      press.button.toggleAttribute(ACTIVE, isOver);
      press.button.toggleAttribute(HOVER, isOver);
      return;
    }
    if (event.pointerType === "mouse") this.hover(point);
  };

  private onUp = (event: PointerEvent) => {
    const point = this.source(event);
    const { drag, press } = this;
    if (drag?.pointerId === event.pointerId) {
      event.stopPropagation();
      this.drag = null;
    }
    if (press?.pointerId === event.pointerId) {
      event.stopPropagation();
      this.press = null;
      press.button.removeAttribute(ACTIVE);
      if (contains(press.button.getBoundingClientRect(), point)) press.button.click();
    }
    if (event.pointerType === "mouse") this.hover(point);
    else this.setHovered(null);
  };

  private onCancel = (event: PointerEvent) => {
    if (this.drag?.pointerId === event.pointerId) this.drag = null;
    if (this.press?.pointerId === event.pointerId) {
      this.press.button.removeAttribute(ACTIVE);
      this.press = null;
    }
    this.setHovered(null);
  };

  private onLeave = () => {
    if (this.drag || this.press) return;
    this.setHovered(null);
    this.plot.style.cursor = "";
  };

  /** Scrolling over a panel doesn't zoom the plot. */
  private onWheel = (event: WheelEvent) => {
    if (this.panelAt(this.source(event))) {
      event.stopPropagation();
      event.preventDefault();
    }
  };
}
