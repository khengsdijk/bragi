/**
 * CIEDE2000 colour difference (Sharma, Wu & Dalal 2005), used to keep the role, section and
 * energy palettes distinguishable — including under colour-blind simulation, where hue
 * differences collapse and only this metric tells the truth.
 */

import type { Lab } from "./color.js";

const DEG = Math.PI / 180;

/** ΔE00 between two Lab colours. 0 = identical; ~1 is the just-noticeable difference. */
export function ciede2000(first: Lab, second: Lab): number {
  const { l: l1, a: a1, b: b1 } = first;
  const { l: l2, a: a2, b: b2 } = second;

  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar = (c1 + c2) / 2;
  const cBar7 = cBar ** 7;
  const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + 25 ** 7)));

  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);

  const h1p = hueAngle(a1p, b1);
  const h2p = hueAngle(a2p, b2);

  const dLp = l2 - l1;
  const dCp = c2p - c1p;
  const dhp = deltaHue(h1p, h2p, c1p, c2p);
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dhp / 2) * DEG);

  const lBarP = (l1 + l2) / 2;
  const cBarP = (c1p + c2p) / 2;
  const hBarP = meanHue(h1p, h2p, c1p, c2p);

  const t =
    1 -
    0.17 * Math.cos((hBarP - 30) * DEG) +
    0.24 * Math.cos(2 * hBarP * DEG) +
    0.32 * Math.cos((3 * hBarP + 6) * DEG) -
    0.2 * Math.cos((4 * hBarP - 63) * DEG);

  const dTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2));
  const cBarP7 = cBarP ** 7;
  const rc = 2 * Math.sqrt(cBarP7 / (cBarP7 + 25 ** 7));
  const sl = 1 + (0.015 * (lBarP - 50) ** 2) / Math.sqrt(20 + (lBarP - 50) ** 2);
  const sc = 1 + 0.045 * cBarP;
  const sh = 1 + 0.015 * cBarP * t;
  const rt = -Math.sin(2 * dTheta * DEG) * rc;

  return Math.sqrt(
    (dLp / sl) ** 2 + (dCp / sc) ** 2 + (dHp / sh) ** 2 + rt * (dCp / sc) * (dHp / sh),
  );
}

function hueAngle(a: number, b: number): number {
  if (a === 0 && b === 0) return 0;
  const angle = Math.atan2(b, a) / DEG;
  return angle >= 0 ? angle : angle + 360;
}

function deltaHue(h1: number, h2: number, c1: number, c2: number): number {
  if (c1 * c2 === 0) return 0;
  const diff = h2 - h1;
  if (Math.abs(diff) <= 180) return diff;
  return diff > 180 ? diff - 360 : diff + 360;
}

function meanHue(h1: number, h2: number, c1: number, c2: number): number {
  if (c1 * c2 === 0) return h1 + h2;
  const sum = h1 + h2;
  if (Math.abs(h1 - h2) <= 180) return sum / 2;
  return sum < 360 ? (sum + 360) / 2 : (sum - 360) / 2;
}
