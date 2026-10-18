/**
 * OKLCH ↔ sRGB (Björn Ottosson's OKLab, 2020). Much smaller than a colour library and enough
 * for what the tokens need: the palette is authored in OKLCH, committed as hex, and
 * `tokens:report` prints the OKLCH numbers back for the next edit.
 */

import { formatHex, linearToSrgb, type Rgba, srgbToLinear } from "./color.js";

export interface Oklch {
  /** Perceptual lightness, 0…1. */
  readonly l: number;
  /** Chroma, 0…~0.4 for sRGB. */
  readonly c: number;
  /** Hue angle in degrees, 0…360. */
  readonly h: number;
}

export function oklchToRgb(l: number, c: number, h: number, a = 1): Rgba {
  const radians = (h * Math.PI) / 180;
  const aAxis = c * Math.cos(radians);
  const bAxis = c * Math.sin(radians);

  const lp = l + 0.3963377774 * aAxis + 0.2158037573 * bAxis;
  const mp = l - 0.1055613458 * aAxis - 0.0638541728 * bAxis;
  const sp = l - 0.0894841775 * aAxis - 1.291485548 * bAxis;

  const lc = lp ** 3;
  const mc = mp ** 3;
  const sc = sp ** 3;

  const red = 4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc;
  const green = -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc;
  const blue = -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc;

  return { r: linearToSrgb(red), g: linearToSrgb(green), b: linearToSrgb(blue), a };
}

export function oklchToHex(l: number, c: number, h: number): string {
  return formatHex(oklchToRgb(l, c, h));
}

export function rgbToOklch(color: Rgba): Oklch {
  const red = srgbToLinear(color.r);
  const green = srgbToLinear(color.g);
  const blue = srgbToLinear(color.b);

  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);

  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const aAxis = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bAxis = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  const hue = (Math.atan2(bAxis, aAxis) * 180) / Math.PI;
  return {
    l: lightness,
    c: Math.hypot(aAxis, bAxis),
    h: hue < 0 ? hue + 360 : hue,
  };
}

/** Compact `oklch(0.72 0.15 258)` text, for the report and for the SVG legend. */
export function formatOklch(color: Rgba): string {
  const { l, c, h } = rgbToOklch(color);
  return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`;
}
