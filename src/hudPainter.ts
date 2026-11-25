import { MAX_PIXEL_RATIO } from "./renderer";

/** Where a painted panel sits, in CSS pixels from the plot's top left. */
export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Room around a panel for its glow, in CSS pixels.
const MARGIN = 16;
// Matches the player-pulse animation in styles.css.
const PULSE_SECONDS = 1.6;
const PAINT_EVENTS = ["pointerover", "pointerout", "pointerdown", "pointerup", "focusin", "focusout", "input"];

/** A CSS hex color (#rrggbb) at some opacity, for canvas shadows. */
function withAlpha(hex: string, alpha: number) {
  const value = parseInt(hex.trim().slice(1), 16);
  return `rgb(${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255} / ${alpha})`;
}

/** What a panel's paint routine gets: the canvas, the HUD colors and drawing helpers. */
export interface PaintKit {
  ctx: CanvasRenderingContext2D;
  root: HTMLElement;
  hud: string;
  dim: string;
  faint: string;
  /** Sets a soft glow in the HUD color for what's drawn next. */
  glow: (blur: number, alpha: number) => void;
  withAlpha: (hex: string, alpha: number) => string;
  /** Calls `draw` for each visible element matching `selector`, with its box, state saved around it. */
  each: (selector: string, draw: (element: HTMLElement, r: DOMRect) => void) => void;
  /** Draws an element's text as styled: font, color, opacity, spacing, case, tabular digits. */
  text: (element: HTMLElement, r: DOMRect, hasGlow: boolean) => void;
  /** Draws an inline SVG icon, filling or stroking each path as its attributes say. */
  icon: (svg: SVGSVGElement, hasGlow: boolean) => void;
  /** The HUD panel: a 1px outline with a soft glow, a dark fill, a sheen and faint scanlines. */
  panel: (box: DOMRect) => void;
  /** A 1px outline around a focused control, as its :focus-visible style draws it. */
  focusRing: (r: DOMRect, offset: number) => void;
}

/**
 * Paints a UI panel into a canvas so it can be drawn inside the WebGL frame and get the
 * same screen effects as the plot. The HTML stays on top, invisible, for clicks, keyboard
 * and screen readers; layout, fonts and colors are all read from it, so styles.css stays
 * the source of how each panel looks. `paintContent` draws one kind of panel.
 */
export class HudPainter {
  private canvas = document.createElement("canvas");
  private context = this.canvas.getContext("2d")!;
  private frame = 0;
  private mutations: MutationObserver;
  private resizes: ResizeObserver;

  constructor(
    private root: HTMLElement,
    private plot: HTMLCanvasElement,
    private paintContent: (kit: PaintKit) => void,
    private onPaint: (canvas: HTMLCanvasElement, rect: OverlayRect) => void,
    /** Whether the panel animates, so it's painted every frame. */
    private isAnimated: (root: HTMLElement) => boolean = () => false,
  ) {
    this.mutations = new MutationObserver(this.request);
    this.mutations.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
    this.resizes = new ResizeObserver(this.request);
    this.resizes.observe(root);
    this.resizes.observe(plot);
    for (const type of PAINT_EVENTS) root.addEventListener(type, this.request);
    void document.fonts.ready.then(this.request);
    this.request();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.mutations.disconnect();
    this.resizes.disconnect();
    for (const type of PAINT_EVENTS) this.root.removeEventListener(type, this.request);
  }

  private request = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
      if (this.isAnimated(this.root)) this.request();
    });
  };

  private paint() {
    const { canvas, context: ctx, root } = this;
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    const plotBox = this.plot.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    const rect: OverlayRect = {
      x: box.left - plotBox.left - MARGIN,
      y: box.top - plotBox.top - MARGIN,
      width: box.width + MARGIN * 2,
      height: box.height + MARGIN * 2,
    };
    const width = Math.max(1, Math.ceil(rect.width * ratio));
    const height = Math.max(1, Math.ceil(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    // Draw in page coordinates, straight from the elements' boxes.
    ctx.setTransform(ratio, 0, 0, ratio, -(box.left - MARGIN) * ratio, -(box.top - MARGIN) * ratio);

    const css = getComputedStyle(root);
    const hud = css.getPropertyValue("--hud").trim();
    const dim = css.getPropertyValue("--hud-dim").trim();
    const faint = css.getPropertyValue("--hud-faint").trim();
    const panelFill = css.getPropertyValue("--hud-panel").trim();
    const glow = (blur: number, alpha: number) => {
      ctx.shadowColor = withAlpha(hud, alpha);
      ctx.shadowBlur = blur * ratio;
    };

    const kit: PaintKit = {
      ctx,
      root,
      hud,
      dim,
      faint,
      glow,
      withAlpha,
      each(selector, draw) {
        for (const element of root.querySelectorAll<HTMLElement>(selector)) {
          const r = element.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          ctx.save();
          draw(element, r);
          ctx.restore();
        }
      },
      text(element, r, hasGlow) {
        const style = getComputedStyle(element);
        ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        ctx.fillStyle = style.color;
        ctx.globalAlpha *= parseFloat(style.opacity);
        ctx.textBaseline = "middle";
        if (hasGlow) glow(6, 0.55);
        const spacing = parseFloat(style.letterSpacing) || 0;
        const content = element.textContent ?? "";
        // With tabular-nums, every digit gets the widest digit's room, centered in it, so
        // changing numbers don't shift the text.
        const tabular = style.fontVariantNumeric.includes("tabular-nums");
        const digitWidth = Math.max(...[..."0123456789"].map((digit) => ctx.measureText(digit).width));
        let x = r.left;
        const y = r.top + r.height / 2;
        for (const character of style.textTransform === "uppercase" ? content.toUpperCase() : content) {
          const characterWidth = ctx.measureText(character).width;
          if (tabular && character >= "0" && character <= "9") {
            ctx.fillText(character, x + (digitWidth - characterWidth) / 2, y);
            x += digitWidth + spacing;
          } else {
            ctx.fillText(character, x, y);
            x += characterWidth + spacing;
          }
        }
      },
      icon(svg, hasGlow) {
        const iconBox = svg.getBoundingClientRect();
        const viewBox = svg.viewBox.baseVal;
        ctx.save();
        if (hasGlow) glow(4, 0.6);
        ctx.translate(iconBox.left, iconBox.top);
        ctx.scale(iconBox.width / (viewBox?.width || 24), iconBox.height / (viewBox?.height || 24));
        for (const path of svg.querySelectorAll("path")) {
          const shape = new Path2D(path.getAttribute("d") ?? "");
          const stroke = path.getAttribute("stroke");
          if (stroke && stroke !== "none") {
            ctx.strokeStyle = hud;
            ctx.lineWidth = parseFloat(path.getAttribute("stroke-width") ?? "1");
            ctx.lineCap = (path.getAttribute("stroke-linecap") as CanvasLineCap | null) ?? "butt";
            ctx.stroke(shape);
          }
          if (path.getAttribute("fill") !== "none") {
            ctx.fillStyle = hud;
            ctx.fill(shape);
          }
        }
        ctx.restore();
      },
      panel(panelBox) {
        ctx.save();
        glow(10, 0.18);
        ctx.fillStyle = dim;
        ctx.fillRect(panelBox.left, panelBox.top, panelBox.width, panelBox.height);
        ctx.restore();
        ctx.save();
        ctx.beginPath();
        ctx.rect(panelBox.left + 1, panelBox.top + 1, panelBox.width - 2, panelBox.height - 2);
        ctx.globalCompositeOperation = "destination-out";
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = panelFill;
        ctx.fill();
        ctx.clip();
        const sheen = ctx.createLinearGradient(0, panelBox.top, 0, panelBox.bottom);
        sheen.addColorStop(0, withAlpha(hud, 0.07));
        sheen.addColorStop(0.55, withAlpha(hud, 0));
        ctx.fillStyle = sheen;
        ctx.fillRect(panelBox.left, panelBox.top, panelBox.width, panelBox.height);
        ctx.fillStyle = withAlpha(hud, 0.04);
        for (let y = panelBox.bottom - 1; y > panelBox.top; y -= 3) ctx.fillRect(panelBox.left, y, panelBox.width, 1);
        ctx.restore();
      },
      focusRing(r, offset) {
        ctx.save();
        ctx.strokeStyle = hud;
        ctx.lineWidth = 1;
        ctx.strokeRect(r.left - offset - 0.5, r.top - offset - 0.5, r.width + offset * 2 + 1, r.height + offset * 2 + 1);
        ctx.restore();
      },
    };
    this.paintContent(kit);
    this.onPaint(canvas, rect);
  }
}

/** The playing light pulses, so the player is painted every frame while it's on. */
export const isPlayerAnimated = (root: HTMLElement) => root.querySelector(".player-light.is-on") !== null;

/** The player: date, transport buttons and speed meter. */
export function paintPlayer(kit: PaintKit) {
  const { ctx, root, hud, dim, faint, glow, each, text, icon, panel, focusRing } = kit;
  panel(root.getBoundingClientRect());

  each(".player-divider", (_, r) => {
    const line = ctx.createLinearGradient(0, r.top, 0, r.bottom);
    line.addColorStop(0, "transparent");
    line.addColorStop(0.5, dim);
    line.addColorStop(1, "transparent");
    ctx.fillStyle = line;
    ctx.fillRect(r.left, r.top, r.width, r.height);
  });

  each(".player-light", (element, r) => {
    ctx.strokeStyle = dim;
    ctx.lineWidth = 1;
    if (element.classList.contains("is-on")) {
      const phase = (performance.now() / 1000 / PULSE_SECONDS) % 1;
      ctx.globalAlpha = 1 - 0.65 * (0.5 - 0.5 * Math.cos(phase * 2 * Math.PI));
      glow(6, 0.55);
      ctx.fillStyle = hud;
      ctx.fillRect(r.left, r.top, r.width, r.height);
    }
    ctx.strokeRect(r.left + 0.5, r.top + 0.5, r.width - 1, r.height - 1);
  });

  each(".player-date", (element, r) => text(element, r, true));
  each(".player-speed-text", (element, r) => text(element, r, false));

  each(".player-button", (element, r) => {
    const button = element as HTMLButtonElement;
    const style = getComputedStyle(button);
    const isLive = !button.disabled;
    if (!isLive) ctx.globalAlpha = 0.3;
    const isHover = isLive && button.matches(":hover, [data-hover]");
    const isActive = isLive && button.matches(":active, [data-active]");
    const background = isActive
      ? kit.withAlpha(hud, 0.22)
      : isHover || button.classList.contains("is-playing")
        ? faint
        : null;
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(r.left, r.top, r.width, r.height);
    }
    ctx.strokeStyle = style.borderTopColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(r.left + 0.5, r.top + 0.5, r.width - 1, r.height - 1);
    // Corner brackets, top left and bottom right.
    ctx.fillStyle = dim;
    ctx.fillRect(r.left - 1, r.top - 1, 6, 1);
    ctx.fillRect(r.left - 1, r.top - 1, 1, 6);
    ctx.fillRect(r.right - 5, r.bottom, 6, 1);
    ctx.fillRect(r.right, r.bottom - 5, 1, 6);
    if (button.matches(":focus-visible")) focusRing(r, 2);
    const svg = button.querySelector("svg");
    if (svg) icon(svg, isHover);
  });

  each(".speed-tick", (element, r) => {
    if (element.classList.contains("is-current")) {
      glow(6, 0.55);
      ctx.fillStyle = hud;
    } else {
      ctx.fillStyle = element.classList.contains("is-lit") ? dim : faint;
    }
    ctx.fillRect(r.left, r.top, r.width, r.height);
  });
}

/** The filter panel: header, then a two-thumb slider per filter. */
export function paintFilters(kit: PaintKit) {
  const { ctx, root, hud, dim, faint, glow, each, text, icon, panel, focusRing } = kit;
  panel(root.getBoundingClientRect());

  each(".filters-toggle", (element, r) => {
    const label = element.querySelector<HTMLElement>("span");
    if (label) text(label, label.getBoundingClientRect(), false);
    const svg = element.querySelector("svg");
    if (svg) icon(svg, false);
    if (element.matches(":focus-visible")) focusRing(r, 2);
  });
  each(".filters-reset", (element, r) => {
    text(element, r, false);
    if (element.matches(":focus-visible")) focusRing(r, 2);
  });
  // The rule between the header and the sliders.
  each(".filters-body", (_, r) => {
    ctx.fillStyle = faint;
    ctx.fillRect(r.left, r.top, r.width, 1);
  });
  each(".filter-name", (element, r) => text(element, r, false));
  each(".filter-value", (element, r) => text(element, r, false));

  each(".filter-range", (element, r) => {
    const thumb = parseFloat(getComputedStyle(root).getPropertyValue("--thumb")) || 10;
    const [lowInput, highInput] = element.querySelectorAll("input");
    if (!lowInput || !highInput) return;
    const share = (input: HTMLInputElement) => Number(input.value) / Number(input.max);
    const start = r.left + thumb / 2;
    const span = r.width - thumb;
    const y = r.top + r.height / 2;
    const [low, high] = [start + span * share(lowInput), start + span * share(highInput)];
    // The track: faint end to end, brighter between the thumbs.
    ctx.fillStyle = faint;
    ctx.fillRect(start, y - 1, span, 2);
    ctx.fillStyle = dim;
    ctx.fillRect(low, y - 1, high - low, 2);
    for (const [input, x] of [
      [lowInput, low],
      [highInput, high],
    ] as const) {
      ctx.save();
      glow(6, 0.55);
      ctx.fillStyle = hud;
      ctx.fillRect(x - thumb / 2, y - thumb / 2, thumb, thumb);
      ctx.restore();
      if (input.matches(":focus-visible")) focusRing(new DOMRect(x - thumb / 2, y - thumb / 2, thumb, thumb), 2);
    }
  });
}
