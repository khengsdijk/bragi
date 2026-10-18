/**
 * Colour-blind simulation with the Machado, Oliveira & Fernandes (2009) severity-1.0
 * dichromacy matrices, applied in linear-light sRGB.
 *
 * Source: "A Physiologically-based Model for Simulation of Color Vision Deficiency",
 * IEEE TVCG 15(6), 2009 — the published 1.0-severity matrices.
 */

import { fromLinearRgb, type Rgba, toLinearRgb } from "./color.js";

export const SIMULATIONS = ["protanopia", "deuteranopia", "tritanopia"] as const;

export type Simulation = (typeof SIMULATIONS)[number];

export const SIMULATION_LABELS: Readonly<Record<Simulation, string>> = {
  protanopia: "Protanopia (no red cones)",
  deuteranopia: "Deuteranopia (no green cones)",
  tritanopia: "Tritanopia (no blue cones)",
};

/** Row-major 3×3 matrices, linear-light sRGB. */
const MATRICES: Readonly<
  Record<
    Simulation,
    readonly [number, number, number, number, number, number, number, number, number]
  >
> = {
  protanopia: [
    0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998,
  ],
  deuteranopia: [
    0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881,
  ],
  tritanopia: [
    1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039,
  ],
};

export function simulate(color: Rgba, simulation: Simulation): Rgba {
  const matrix = MATRICES[simulation];
  const [r, g, b] = toLinearRgb(color);
  const out: [number, number, number] = [
    matrix[0] * r + matrix[1] * g + matrix[2] * b,
    matrix[3] * r + matrix[4] * g + matrix[5] * b,
    matrix[6] * r + matrix[7] * g + matrix[8] * b,
  ];
  return fromLinearRgb([clamp01(out[0]), clamp01(out[1]), clamp01(out[2])], color.a);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
