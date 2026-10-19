import { describe, expect, it } from "vitest";

import {
  formatDb,
  formatHz,
  formatNoteValue,
  formatPan,
  formatParamValue,
  formatRatio,
  formatVibe,
  paramStep,
} from "../format.js";

describe("Inspector value text", () => {
  it("writes dB with a true minus sign and one decimal", () => {
    expect(formatDb(0)).toBe("0.0 dB");
    expect(formatDb(-3)).toBe("−3.0 dB");
    expect(formatDb(3.25)).toBe("3.3 dB");
  });

  it("switches frequencies to kHz and keeps ratios as n:1", () => {
    expect(formatHz(800)).toBe("800 Hz");
    expect(formatHz(12000)).toBe("12 kHz");
    expect(formatRatio(4)).toBe("4.0:1");
  });

  it("writes pan as words", () => {
    expect(formatPan(-0.2)).toBe("20% left");
    expect(formatPan(0)).toBe("Centre");
    expect(formatPan(0.2)).toBe("20% right");
  });

  it("writes vibe values against their own poles", () => {
    expect(formatVibe(0, ["Darker", "Brighter"])).toBe("Unchanged");
    expect(formatVibe(-0.4, ["Darker", "Brighter"])).toBe("Darker 40%");
  });

  it("writes delay time as a note value and falls back to beats", () => {
    expect(formatNoteValue(0.25)).toBe("1/16");
    expect(formatNoteValue(0.5)).toBe("1/8");
    expect(formatNoteValue(0.3)).toBe("0.30 beats");
  });

  it("uses each parameter's natural unit and step", () => {
    const mix = { type: "number", min: 0, max: 1, default: 0.5 } as const;
    const cutoff = { type: "number", min: 20, max: 20000, default: 20000 } as const;
    expect(formatParamValue("mix", 0.4, mix)).toBe("40%");
    expect(formatParamValue("cutoffHz", 2000, cutoff)).toBe("2.0 kHz");
    expect(paramStep("mix", mix)).toBe(0.01);
    expect(paramStep("cutoffHz", cutoff)).toBe(1);
  });
});
