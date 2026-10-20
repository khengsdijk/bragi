/**
 * The paint brushes in the tools area (07 §1, §4.4): a Paint toggle, the nine instant brushes,
 * the strength slider and, for Filter sweep, its direction. Everything is DOM, so it is keyboard
 * reachable and readable by assistive tech even though the canvas is not (11 §6.1).
 */
import { Button, SegmentedControl, Slider } from "@bragi/design";
import { type ReactNode, useId } from "react";
import { useStore } from "zustand";

import { type MessageKey, t } from "../../../i18n/index.js";
import type { BrushStore } from "../state/brush-store.js";
import { BRUSH_IDS, type BrushId, type FilterDirection } from "../types.js";

const DIRECTIONS: readonly FilterDirection[] = ["up", "down"];

function brushLabel(brush: BrushId): string {
  return t(`brush.name.${brush}` as MessageKey);
}

function strengthWord(value: number): string {
  if (value < 0.34) return t("brush.strength.soft");
  if (value < 0.67) return t("brush.strength.medium");
  return t("brush.strength.strong");
}

export interface BrushPaletteProps {
  readonly store: BrushStore;
}

export function BrushPalette({ store }: BrushPaletteProps): ReactNode {
  const tool = useStore(store.store, (state) => state.tool);
  const brush = useStore(store.store, (state) => state.brush);
  const strength = useStore(store.store, (state) => state.sizeStrength);
  const direction = useStore(store.store, (state) => state.direction);
  const name = useId();

  return (
    <section
      className="brush-palette"
      aria-label={t("brush.palette.label")}
      data-testid="brush-palette"
    >
      <Button
        variant={tool === "paint" ? "secondary" : "ghost"}
        size="sm"
        aria-pressed={tool === "paint"}
        onClick={() => store.togglePaint()}
        data-testid="brush-paint-toggle"
      >
        {t("brush.paint")}
      </Button>
      <fieldset className="brush-palette__brushes">
        <legend className="brush-palette__legend">{t("brush.brushLabel")}</legend>
        <div className="brush-palette__options">
          {BRUSH_IDS.map((id) => (
            <label key={id} className="brush-palette__option" data-checked={id === brush}>
              <input
                className="brush-palette__radio"
                type="radio"
                name={name}
                value={id}
                checked={id === brush}
                onChange={() => store.setBrush(id)}
              />
              <span className="brush-palette__optionText">{brushLabel(id)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="brush-palette__strength">
        <Slider
          label={t("brush.strength")}
          value={strength}
          min={0}
          max={1}
          step={0.05}
          formatValue={strengthWord}
          onValueChange={(next) => store.setSizeStrength(next)}
        />
      </div>
      {brush === "filterSweep" ? (
        <SegmentedControl
          label={t("brush.direction")}
          value={direction}
          options={DIRECTIONS.map((value) => ({
            value,
            label: t(value === "up" ? "brush.direction.rising" : "brush.direction.falling"),
          }))}
          onChange={(value) => store.setDirection(value as FilterDirection)}
          className="brush-palette__direction"
        />
      ) : null}
    </section>
  );
}
