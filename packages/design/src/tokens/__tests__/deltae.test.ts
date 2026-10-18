import { describe, expect, it } from "vitest";

import { type Lab, parseColor, toLab } from "../color.js";
import { ciede2000 } from "../deltae.js";

/**
 * Sharma, Wu & Dalal (2005) test data — the reference pairs every CIEDE2000 implementation is
 * checked against. Each pair is [Lab1, Lab2, expected ΔE00].
 */
const SHARMA: readonly (readonly [readonly number[], readonly number[], number])[] = [
  [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
  [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
  [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
  [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
  [[50, -1.1848, -84.8006], [50, 0, -82.7485], 1.0],
  [[50, -0.9009, -85.5211], [50, 0, -82.7485], 1.0],
  [[50, 0, 0], [50, -1, 2], 2.3669],
  [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
  [[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195],
  [[50, 2.5, 0], [73, 25, -18], 27.1492],
  [[50, 2.5, 0], [61, -5, 29], 22.8977],
  [[50, 2.5, 0], [56, -27, -3], 31.903],
  [[50, 2.5, 0], [58, 24, 15], 19.4535],
  [[50, 2.5, 0], [50, 3.1736, 0.5854], 1.0],
  [[50, 2.5, 0], [50, 3.2972, 0], 1.0],
  [[50, 2.5, 0], [50, 1.8634, 0.5757], 1.0],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.263],
  [[61.2901, 3.7196, -5.3901], [61.4292, 2.248, -4.962], 1.8731],
  [[35.0831, -44.1164, 3.7933], [35.0232, -40.0716, 1.5901], 1.8645],
  [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
  [[36.4612, 47.858, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
  [[90.8027, -2.0831, 1.441], [91.1528, -1.6435, 0.0447], 1.4441],
  [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
  [[6.7747, -0.2908, -2.4247], [5.8714, -0.0985, -2.2286], 0.6377],
  [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
];

function lab(values: readonly number[]): Lab {
  return { l: values[0] ?? 0, a: values[1] ?? 0, b: values[2] ?? 0 };
}

describe("ciede2000", () => {
  it.each(SHARMA)("matches the reference pair %j (%j → %f)", (first, second, expected) => {
    expect(ciede2000(lab(first), lab(second))).toBeCloseTo(expected, 4);
  });

  it("is symmetric", () => {
    for (const [first, second] of SHARMA) {
      expect(ciede2000(lab(first), lab(second))).toBeCloseTo(
        ciede2000(lab(second), lab(first)),
        10,
      );
    }
  });

  it("is zero for a colour against itself and grows with distance", () => {
    const grey = toLab(parseColor("#808080"));
    const lighter = toLab(parseColor("#909090"));
    const white = toLab(parseColor("#ffffff"));
    expect(ciede2000(grey, grey)).toBeCloseTo(0, 10);
    expect(ciede2000(grey, lighter)).toBeLessThan(ciede2000(grey, white));
  });
});
