import { MAX_PIXEL_RATIO } from "./renderer";

/** Where the painted player sits, in CSS pixels from the plot's top left. */
export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Room around the player for its glow, in CSS pixels.
const MARGIN = 16;
// Matches the player-pulse animation in styles.css.
const PULSE_SECONDS = 1.6;

/** A CSS hex color (#rrggbb) at some opacity, for canvas shadows. */
function withAlpha(hex: string, alpha: number) {
  const value = parseInt(hex.trim().slice(1), 16);
  return `rgb(${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255} / ${alpha})`;
}

/**
 * Paints the player into a canvas so it can be drawn inside the WebGL frame and get the
 * same screen effects as the plot. The HTML player stays on top, invisible, for clicks,
 * keyboard and screen readers; layout, fonts and colors are all read from it, so
 * styles.css stays the source of how the player looks.
 */
export class HudPainter {
  private canvas = document.createElement("canvas");
  private context = this.canvas.getContext("2d")!;
  private frame = 0;
  private mutations: MutationObserver;
  private resizes: ResizeObserver;

  constructor(
    private player: HTMLElement,
    private plot: HTMLCanvasElement,
    private onPaint: (canvas: HTMLCanvasElement, rect: OverlayRect) => void,
  ) {
    this.mutations = new MutationObserver(this.request);
    this.mutations.observe(player, { subtree: true, childList: true, characterData: true, attributes: true });
    this.resizes = new ResizeObserver(this.request);
    this.resizes.observe(player);
    this.resizes.observe(plot);
    for (const type of ["pointerover", "pointerout", "pointerdown", "pointerup", "focusin", "focusout"]) {
      player.addEventListener(type, this.request);
    }
    void document.fonts.ready.then(this.request);
    this.request();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.mutations.disconnect();
    this.resizes.disconnect();
    for (const type of ["pointerover", "pointerout", "pointerdown", "pointerup", "focusin", "focusout"]) {
      this.player.removeEventListener(type, this.request);
    }
  }

  private request = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
      // The playing light pulses, so keep painting while it's on.
      if (this.player.querySelector(".player-light.is-on")) this.request();
    });
  };

  private paint() {
    const { canvas, context: ctx, player } = this;
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    const plotBox = this.plot.getBoundingClientRect();
    const box = player.getBoundingClientRect();
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

    const css = getComputedStyle(player);
    const hud = css.getPropertyValue("--hud").trim();
    const dim = css.getPropertyValue("--hud-dim").trim();
    const faint = css.getPropertyValue("--hud-faint").trim();
    const panel = css.getPropertyValue("--hud-panel").trim();
    const glow = (blur: number, alpha: number) => {
      ctx.shadowColor = withAlpha(hud, alpha);
      ctx.shadowBlur = blur * ratio;
    };

    // The outline, then the panel inset 1px inside it.
    ctx.save();
    glow(10, 0.18);
    ctx.fillStyle = dim;
    ctx.fillRect(box.left, box.top, box.width, box.height);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.left + 1, box.top + 1, box.width - 2, box.height - 2);
    ctx.globalCompositeOperation = "destination-out";
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = panel;
    ctx.fill();
    ctx.clip();
    const sheen = ctx.createLinearGradient(0, box.top, 0, box.bottom);
    sheen.addColorStop(0, withAlpha(hud, 0.07));
    sheen.addColorStop(0.55, withAlpha(hud, 0));
    ctx.fillStyle = sheen;
    ctx.fillRect(box.left, box.top, box.width, box.height);
    ctx.fillStyle = withAlpha(hud, 0.04);
    for (let y = box.bottom - 1; y > box.top; y -= 3) ctx.fillRect(box.left, y, box.width, 1);
    ctx.restore();

    const each = (selector: string, draw: (element: HTMLElement, r: DOMRect) => void) => {
      for (const element of player.querySelectorAll<HTMLElement>(selector)) {
        const r = element.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        ctx.save();
        draw(element, r);
        ctx.restore();
      }
    };

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

    const text = (element: HTMLElement, r: DOMRect, hasGlow: boolean) => {
      const style = getComputedStyle(element);
      ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      ctx.fillStyle = style.color;
      ctx.globalAlpha = parseFloat(style.opacity);
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
        const width = ctx.measureText(character).width;
        if (tabular && character >= "0" && character <= "9") {
          ctx.fillText(character, x + (digitWidth - width) / 2, y);
          x += digitWidth + spacing;
        } else {
          ctx.fillText(character, x, y);
          x += width + spacing;
        }
      }
    };
    each(".player-date", (element, r) => text(element, r, true));
    each(".player-speed-text", (element, r) => text(element, r, false));

    each(".player-button", (element, r) => {
      const button = element as HTMLButtonElement;
      const style = getComputedStyle(button);
      const isLive = !button.disabled;
      if (!isLive) ctx.globalAlpha = 0.3;
      const isHover = isLive && button.matches(":hover");
      const isActive = isLive && button.matches(":active");
      const background = isActive
        ? withAlpha(hud, 0.22)
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
      if (button.matches(":focus-visible")) {
        ctx.strokeStyle = hud;
        ctx.strokeRect(r.left - 2.5, r.top - 2.5, r.width + 5, r.height + 5);
      }
      const icon = button.querySelector("svg");
      const path = icon?.querySelector("path")?.getAttribute("d");
      if (icon && path) {
        const iconBox = icon.getBoundingClientRect();
        if (isHover) glow(4, 0.6);
        ctx.translate(iconBox.left, iconBox.top);
        ctx.scale(iconBox.width / 24, iconBox.height / 24);
        ctx.fillStyle = hud;
        ctx.fill(new Path2D(path));
      }
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

    this.onPaint(canvas, rect);
  }
}
