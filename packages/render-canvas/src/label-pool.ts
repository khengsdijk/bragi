/**
 * A pool of Pixi `Text` objects for labels that come and go with every pan and zoom.
 *
 * Creating and destroying `Text` per frame is what makes canvas label rendering janky, so the
 * canvas rents labels for one rebuild (`begin` ... `end`) and unused ones are hidden, not freed.
 * The text and style are only touched when they change, because re-rasterising a label is the
 * expensive part.
 */
import { type Container, Text } from "pixi.js";

export interface LabelStyle {
  readonly fill: number;
  readonly fontSize: number;
  readonly fontWeight?: "400" | "500" | "600";
}

interface Slot {
  readonly text: Text;
  key: string;
}

export class LabelPool {
  private readonly slots: Slot[] = [];
  private used = 0;

  constructor(
    readonly layer: Container,
    private readonly fontFamily: string,
    private readonly resolution: number,
  ) {}

  /** Starts a rebuild: every label is free again. */
  begin(): void {
    this.used = 0;
  }

  /**
   * Places a label. `anchorX` and `anchorY` are 0..1 within the text box (0, 0.5 = left, middle).
   * Returns the label's width in px so callers can decide whether it fits.
   */
  place(text: string, x: number, y: number, style: LabelStyle, anchorX = 0, anchorY = 0.5): number {
    let slot = this.slots[this.used];
    if (!slot) {
      const created = new Text({
        text: "",
        style: { fontFamily: this.fontFamily, fontSize: style.fontSize, fill: style.fill },
        resolution: this.resolution,
      });
      created.roundPixels = true;
      this.layer.addChild(created);
      slot = { text: created, key: "" };
      this.slots.push(slot);
    }
    this.used += 1;
    const key = `${text}|${style.fill}|${style.fontSize}|${style.fontWeight ?? "400"}`;
    if (slot.key !== key) {
      slot.key = key;
      slot.text.text = text;
      slot.text.style.fill = style.fill;
      slot.text.style.fontSize = style.fontSize;
      slot.text.style.fontWeight = style.fontWeight ?? "400";
    }
    slot.text.anchor.set(anchorX, anchorY);
    slot.text.position.set(Math.round(x), Math.round(y));
    slot.text.visible = true;
    return slot.text.width;
  }

  /** Hides labels the last rebuild did not use. */
  end(): void {
    for (let index = this.used; index < this.slots.length; index += 1) {
      const slot = this.slots[index];
      if (slot) slot.text.visible = false;
    }
  }

  /** Measures a string without placing it. */
  measure(text: string, style: LabelStyle): number {
    // Cheap estimate: callers use it for "does it fit", where a few px of error are harmless.
    return text.length * style.fontSize * 0.58;
  }

  destroy(): void {
    for (const slot of this.slots) slot.text.destroy();
    this.slots.length = 0;
  }
}
