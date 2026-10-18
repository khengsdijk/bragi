/**
 * Colour maths for the token checks. Pure functions, no dependencies.
 *
 * Tokens are authored in OKLCH and committed as hex (see `tokens.json`), so everything here
 * works on sRGB with a D65 white point. Alpha is supported because a few tokens (the modal
 * scrim) are translucent and must be composited over whatever they are drawn on before a
 * contrast ratio means anything.
 */

export interface Rgba {
  /** 0…255 */
  readonly r: number;
  /** 0…255 */
  readonly g: number;
  /** 0…255 */
  readonly b: number;
  /** 0…1 */
  readonly a: number;
}

export interface Lab {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

const HEX6 = /^#([0-9a-f]{6})$/i;
const HEX8 = /^#([0-9a-f]{8})$/i;
const HEX3 = /^#([0-9a-f]{3})$/i;
const RGB_FN = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+)%?\s*)?\)$/i;

/** Parse `#rgb`, `#rrggbb`, `#rrggbbaa` or `rgb(r g b / p%)`. Throws on anything else. */
export function parseColor(input: string): Rgba {
  const value = input.trim();

  const fn = RGB_FN.exec(value);
  if (fn !== null) {
    const alphaRaw = value.includes("/") || value.includes(",") ? fn[4] : undefined;
    return {
      r: Number(fn[1]),
      g: Number(fn[2]),
      b: Number(fn[3]),
      a: alphaFrom(alphaRaw, value),
    };
  }

  const hex8 = HEX8.exec(value);
  if (hex8 !== null) {
    const digits = hex8[1] ?? "";
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
      a: Number.parseInt(digits.slice(6, 8), 16) / 255,
    };
  }

  const hex6 = HEX6.exec(value);
  if (hex6 !== null) {
    const digits = hex6[1] ?? "";
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
      a: 1,
    };
  }

  const hex3 = HEX3.exec(value);
  if (hex3 !== null) {
    const digits = hex3[1] ?? "";
    const [r, g, b] = [digits[0] ?? "", digits[1] ?? "", digits[2] ?? ""];
    return {
      r: Number.parseInt(`${r}${r}`, 16),
      g: Number.parseInt(`${g}${g}`, 16),
      b: Number.parseInt(`${b}${b}`, 16),
      a: 1,
    };
  }

  throw new Error(`Not a colour: ${JSON.stringify(input)}`);
}

function alphaFrom(raw: string | undefined, source: string): number {
  if (raw === undefined) return 1;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Not an alpha value: ${source}`);
  return source.includes("%") ? value / 100 : value;
}

/** `#rrggbb` for an opaque colour, `#rrggbbaa` otherwise (lower case). */
export function formatHex(color: Rgba): string {
  const channel = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  const base = `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
  return color.a >= 1 ? base : `${base}${channel(color.a * 255)}`;
}

/** Source-over compositing of `fg` onto `bg`, both in sRGB (as CSS does it). */
export function composite(fg: Rgba, bg: Rgba): Rgba {
  if (fg.a >= 1) return fg;
  const bgOpaque = composite(bg, { r: 0, g: 0, b: 0, a: 1 });
  const mix = (f: number, b: number): number => f * fg.a + b * (1 - fg.a);
  return {
    r: mix(fg.r, bgOpaque.r),
    g: mix(fg.g, bgOpaque.g),
    b: mix(fg.b, bgOpaque.b),
    a: 1,
  };
}

/** sRGB → linear-light, per IEC 61966-2-1. */
export function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Linear-light → sRGB, per IEC 61966-2-1. */
export function linearToSrgb(value: number): number {
  const c = Math.max(0, Math.min(1, value));
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
}

export function toLinearRgb(color: Rgba): readonly [number, number, number] {
  return [srgbToLinear(color.r), srgbToLinear(color.g), srgbToLinear(color.b)];
}

export function fromLinearRgb(linear: readonly [number, number, number], a = 1): Rgba {
  return {
    r: linearToSrgb(linear[0]),
    g: linearToSrgb(linear[1]),
    b: linearToSrgb(linear[2]),
    a,
  };
}

/** WCAG 2.x relative luminance. Ignores alpha; call `composite` first. */
export function relativeLuminance(color: Rgba): number {
  const [r, g, b] = toLinearRgb(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two colours (order-independent), 1…21. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Round to 2 decimals — the precision ratios are reported and asserted at. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// --- CIE Lab (D65) -------------------------------------------------------------------------

const D65 = { x: 0.95047, y: 1, z: 1.08883 };

function labF(t: number): number {
  const delta = 6 / 29;
  return t > delta ** 3 ? Math.cbrt(t) : t / (3 * delta ** 2) + 4 / 29;
}

export function toLab(color: Rgba): Lab {
  const [r, g, b] = toLinearRgb(color);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / D65.x;
  const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / D65.y;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / D65.z;
  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}
