/**
 * "Apply brush…" (11 §6.2): the keyboard path to painting. It paints one part's full span on the
 * tracks chosen here, using the same `brushBatch` the canvas stroke commits. The dialog defaults
 * to every instrument in the part, so a keyboard user can apply the current brush with Enter.
 */
import { Button, Dialog, DialogClose, SegmentedControl, Slider } from "@bragi/design";
import type { SectionInstance } from "@bragi/schemas";
import { type ReactNode, useId, useState } from "react";

import { type MessageKey, t } from "../../../i18n/index.js";
import { BRUSH_IDS, type BrushId, type FilterDirection } from "../types.js";

export interface BrushApplyResult {
  readonly brush: BrushId;
  readonly trackIds: readonly string[];
  readonly strength: number;
  readonly direction: FilterDirection;
}

export interface BrushApplyDialogTrack {
  readonly id: string;
  readonly name: string;
}

export interface BrushApplyDialogProps {
  readonly section: SectionInstance;
  readonly tracks: readonly BrushApplyDialogTrack[];
  readonly brush: BrushId;
  readonly strength: number;
  readonly direction: FilterDirection;
  readonly onClose: () => void;
  readonly onApply: (result: BrushApplyResult) => void;
}

function brushLabel(brush: BrushId): string {
  return t(`brush.name.${brush}` as MessageKey);
}

function strengthWord(value: number): string {
  if (value < 0.34) return t("brush.strength.soft");
  if (value < 0.67) return t("brush.strength.medium");
  return t("brush.strength.strong");
}

export function BrushApplyDialog({
  section,
  tracks,
  brush: initialBrush,
  strength: initialStrength,
  direction: initialDirection,
  onClose,
  onApply,
}: BrushApplyDialogProps): ReactNode {
  const [brush, setBrush] = useState<BrushId>(initialBrush);
  const [strength, setStrength] = useState(initialStrength);
  const [direction, setDirection] = useState<FilterDirection>(initialDirection);
  const [selected, setSelected] = useState<readonly string[]>(() =>
    tracks.map((track) => track.id),
  );
  const brushId = useId();

  const toggleTrack = (id: string, checked: boolean): void => {
    setSelected((current) => {
      if (!checked) return current.filter((candidate) => candidate !== id);
      return current.includes(id) ? current : [...current, id];
    });
  };
  const valid = selected.length > 0 && strength > 0;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("brush.apply.title", { label: section.label })}
      description={t("brush.apply.description")}
      closeLabel={t("brush.apply.cancel")}
      size="md"
      footer={
        <>
          <DialogClose asChild>
            <Button>{t("brush.apply.cancel")}</Button>
          </DialogClose>
          <Button
            variant="primary"
            disabled={!valid}
            onClick={() => {
              if (!valid) return;
              onApply({ brush, trackIds: selected, strength, direction });
            }}
          >
            {t("brush.apply.submit")}
          </Button>
        </>
      }
    >
      <label htmlFor={brushId} className="brush-dialog__field">
        <span>{t("brush.apply.brush")}</span>
        <select
          id={brushId}
          className="brush-dialog__input"
          value={brush}
          onChange={(event) => setBrush(event.target.value as BrushId)}
        >
          {BRUSH_IDS.map((option) => (
            <option key={option} value={option}>
              {brushLabel(option)}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="brush-dialog__field brush-dialog__tracks">
        <legend>{t("brush.apply.tracks")}</legend>
        {tracks.length === 0 ? (
          <p className="brush-dialog__hint">{t("brush.apply.noTracks")}</p>
        ) : (
          tracks.map((track) => (
            <label key={track.id} className="brush-dialog__track">
              <input
                type="checkbox"
                checked={selected.includes(track.id)}
                onChange={(event) => toggleTrack(track.id, event.target.checked)}
              />
              <span>{track.name}</span>
            </label>
          ))
        )}
      </fieldset>
      <Slider
        label={t("brush.apply.strength")}
        value={strength}
        min={0}
        max={1}
        step={0.05}
        formatValue={strengthWord}
        onValueChange={setStrength}
      />
      {brush === "filterSweep" ? (
        <SegmentedControl
          label={t("brush.direction")}
          value={direction}
          options={[
            { value: "up", label: t("brush.direction.rising") },
            { value: "down", label: t("brush.direction.falling") },
          ]}
          onChange={(value) => setDirection(value as FilterDirection)}
        />
      ) : null}
    </Dialog>
  );
}
