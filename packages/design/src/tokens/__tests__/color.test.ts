import { describe, expect, it } from "vitest";

import { composite, contrastRatio, formatHex, parseColor, relativeLuminance } from "../color.js";
import { formatOklch, oklchToHex, rgbToOklch } from "../oklch.js";

describe("parseColor / formatHex", () => {
  it("reads every form the token file uses", () => {
    expect(parseColor("#ff0000")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("#f00")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("#ff000080")).toEqual({ r: 255, g: 0, b: 0, a: 128 / 255 });
    expect(parseColor("rgb(10 20 30 / 50%)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
  });

  it("rejects anything else", () => {
    expect(() => parseColor("rebeccapurple")).toThrow();
    expect(() => parseColor("#12345")).toThrow();
  });

  it("round-trips hex, lower-cased and with alpha only when it is not opaque", () => {
    expect(formatHex(parseColor("#AABBCC"))).toBe("#aabbcc");
    expect(formatHex(parseColor("#aabbcc80"))).toBe("#aabbcc80");
  });
});

describe("relative luminance and contrast", () => {
  it("gives the WCAG extremes", () => {
    expect(relativeLuminance(parseColor("#000000"))).toBeCloseTo(0, 10);
    expect(relativeLuminance(parseColor("#ffffff"))).toBeCloseTo(1, 10);
    expect(contrastRatio(parseColor("#ffffff"), parseColor("#000000"))).toBeCloseTo(21, 2);
    expect(contrastRatio(parseColor("#000000"), parseColor("#ffffff"))).toBeCloseTo(21, 2);
  });

  it("matches the published 4.5:1 boundary grey on white", () => {
    // #767676 is the classic "just passes 4.5:1 on white" grey.
    expect(contrastRatio(parseColor("#767676"), parseColor("#ffffff"))).toBeCloseTo(4.54, 2);
    expect(contrastRatio(parseColor("#777777"), parseColor("#ffffff"))).toBeCloseTo(4.48, 2);
  });

  it("is symmetric and never below 1", () => {
    const a = parseColor("#3355ff");
    const b = parseColor("#102030");
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
    expect(contrastRatio(a, a)).toBeCloseTo(1, 10);
  });
});

describe("composite", () => {
  it("returns the source when it is opaque", () => {
    expect(composite(parseColor("#123456"), parseColor("#ffffff"))).toEqual(parseColor("#123456"));
  });

  it("blends a translucent layer over its background", () => {
    const half = composite(parseColor("rgb(0 0 0 / 50%)"), parseColor("#ffffff"));
    expect(half.r).toBeCloseTo(127.5, 1);
    expect(half.a).toBe(1);
  });

  it("darkens the dark-theme canvas, which is all a scrim can do there", () => {
    const canvas = parseColor("#080c14");
    const scrim = composite(parseColor("#03060ddb"), canvas);
    expect(relativeLuminance(scrim)).toBeLessThan(relativeLuminance(canvas));
  });
});

describe("oklch", () => {
  it("maps the achromatic ends exactly", () => {
    expect(oklchToHex(1, 0, 0)).toBe("#ffffff");
    expect(oklchToHex(0, 0, 0)).toBe("#000000");
  });

  it("round-trips a colour through OKLCH", () => {
    const hex = oklchToHex(0.7, 0.15, 250);
    const back = rgbToOklch(parseColor(hex));
    expect(back.l).toBeCloseTo(0.7, 2);
    expect(back.c).toBeCloseTo(0.15, 2);
    expect(back.h).toBeCloseTo(250, 0);
  });

  it("agrees with the published OKLCH value for sRGB red", () => {
    const red = rgbToOklch(parseColor("#ff0000"));
    expect(red.l).toBeCloseTo(0.628, 2);
    expect(red.c).toBeCloseTo(0.258, 2);
    expect(red.h).toBeCloseTo(29.23, 1);
  });

  it("formats a colour for the report", () => {
    expect(formatOklch(parseColor("#ffffff"))).toMatch(/^oklch\(1\.000 0\.000 /);
  });
});
