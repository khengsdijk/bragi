/**
 * The small dialogs the section actions open (07 §4.1–4.2): rename, change type and change length.
 *
 * "Make longer…" offers Loop or Stretch; "Make shorter…" is Trim only, matching 02 §5.2 and the
 * right-edge drag's popover in task C. The bars field is limited to 1–64, the range the plan fixes
 * for a section action.
 */
import { Button, Dialog, DialogClose, SegmentedControl } from "@bragi/design";
import { SECTION_KIND_LIST } from "@bragi/design/tokens";
import type { SectionKind, SectionResizeMode } from "@bragi/schemas";
import { type ReactNode, useState } from "react";

import { t } from "../../../i18n/index.js";
import type { SectionDialog } from "../hooks/use-song-actions.js";

const MIN_BARS = 1;
const MAX_BARS = 64;

/** All `SectionKind` values, taken from the design system's exhaustive family table. */
const SECTION_KINDS = SECTION_KIND_LIST;

function kindLabel(kind: SectionKind): string {
  return t(`song.sectionKind.${kind}` as Parameters<typeof t>[0]);
}

export interface SectionActionDialogsProps {
  readonly dialog: SectionDialog | null;
  readonly onClose: () => void;
  readonly onRename: (sectionId: string, label: string) => void;
  readonly onChangeKind: (sectionId: string, kind: SectionKind) => void;
  readonly onResize: (sectionId: string, bars: number, mode: SectionResizeMode) => void;
}

export function SectionActionDialogs({
  dialog,
  onClose,
  onRename,
  onChangeKind,
  onResize,
}: SectionActionDialogsProps): ReactNode {
  if (dialog === null) return null;
  if (dialog.kind === "rename") {
    return (
      <RenameDialog
        key={`rename:${dialog.sectionId}:${dialog.label}`}
        label={dialog.label}
        onClose={onClose}
        onSubmit={(name) => {
          onRename(dialog.sectionId, name);
          onClose();
        }}
      />
    );
  }
  if (dialog.kind === "changeKind") {
    return (
      <KindDialog
        key={`kind:${dialog.sectionId}:${dialog.sectionKind}`}
        kind={dialog.sectionKind}
        onClose={onClose}
        onSubmit={(kind) => {
          onChangeKind(dialog.sectionId, kind);
          onClose();
        }}
      />
    );
  }
  return (
    <ResizeDialog
      key={`resize:${dialog.sectionId}`}
      dialog={dialog}
      onClose={onClose}
      onSubmit={(bars, mode) => {
        onResize(dialog.sectionId, bars, mode);
        onClose();
      }}
    />
  );
}

interface RenameDialogProps {
  readonly label: string;
  readonly onClose: () => void;
  readonly onSubmit: (label: string) => void;
}

function RenameDialog({ label, onClose, onSubmit }: RenameDialogProps): ReactNode {
  const [name, setName] = useState(label);
  const valid = name.trim() !== "";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("song.rename.title")}
      closeLabel={t("song.rename.cancel")}
      size="sm"
      footer={
        <>
          <DialogClose asChild>
            <Button>{t("song.rename.cancel")}</Button>
          </DialogClose>
          <Button
            variant="primary"
            disabled={!valid}
            onClick={() => {
              if (valid) onSubmit(name.trim());
            }}
          >
            {t("song.rename.save")}
          </Button>
        </>
      }
    >
      <label htmlFor="section-rename" style={FIELD_GROUP_STYLE}>
        <span>{t("song.rename.label")}</span>
        <input
          id="section-rename"
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && valid) onSubmit(name.trim());
          }}
          style={FIELD_STYLE}
        />
      </label>
    </Dialog>
  );
}

interface KindDialogProps {
  readonly kind: SectionKind;
  readonly onClose: () => void;
  readonly onSubmit: (kind: SectionKind) => void;
}

function KindDialog({ kind, onClose, onSubmit }: KindDialogProps): ReactNode {
  const [next, setNext] = useState<SectionKind>(kind);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("song.kind.title")}
      closeLabel={t("song.kind.cancel")}
      size="sm"
      footer={
        <>
          <DialogClose asChild>
            <Button>{t("song.kind.cancel")}</Button>
          </DialogClose>
          <Button
            variant="primary"
            disabled={next === kind}
            onClick={() => {
              if (next !== kind) onSubmit(next);
            }}
          >
            {t("song.kind.save")}
          </Button>
        </>
      }
    >
      <label htmlFor="section-kind" style={FIELD_GROUP_STYLE}>
        <span>{t("song.kind.label")}</span>
        <select
          id="section-kind"
          value={next}
          onChange={(event) => setNext(event.target.value as SectionKind)}
          style={FIELD_STYLE}
        >
          {SECTION_KINDS.map((option) => (
            <option key={option} value={option}>
              {kindLabel(option)}
            </option>
          ))}
        </select>
      </label>
    </Dialog>
  );
}

interface ResizeDialogProps {
  readonly dialog: Extract<SectionDialog, { readonly kind: "resize" }>;
  readonly onClose: () => void;
  readonly onSubmit: (bars: number, mode: SectionResizeMode) => void;
}

function ResizeDialog({ dialog, onClose, onSubmit }: ResizeDialogProps): ReactNode {
  const [bars, setBars] = useState(dialog.bars);
  const [mode, setMode] = useState<SectionResizeMode>(dialog.mode);
  const longer = dialog.direction === "longer";
  const inRange = bars >= MIN_BARS && bars <= MAX_BARS;
  const valid = inRange && bars !== dialog.currentBars;
  const hint = inRange
    ? t(longer ? "song.resize.longerHint" : "song.resize.shorterHint")
    : t("song.resize.invalid");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t(longer ? "song.resize.longerTitle" : "song.resize.shorterTitle")}
      description={hint}
      closeLabel={t("song.resize.cancel")}
      size="sm"
      footer={
        <>
          <DialogClose asChild>
            <Button>{t("song.resize.cancel")}</Button>
          </DialogClose>
          <Button
            variant="primary"
            disabled={!valid}
            onClick={() => {
              if (valid) onSubmit(bars, mode);
            }}
          >
            {t("song.resize.save")}
          </Button>
        </>
      }
    >
      <label htmlFor="section-bars" style={FIELD_GROUP_STYLE}>
        <span>{t("song.resize.bars")}</span>
        <input
          id="section-bars"
          type="number"
          min={MIN_BARS}
          max={MAX_BARS}
          step={1}
          value={bars}
          onChange={(event) => setBars(Number(event.target.value))}
          aria-describedby="section-bars-hint"
          style={FIELD_STYLE}
        />
      </label>
      <p id="section-bars-hint" className="field__hint" style={HINT_STYLE}>
        {t("song.resize.barsHint")}
      </p>
      {longer ? (
        <SegmentedControl
          label={t("song.resize.how")}
          value={mode}
          options={[
            { value: "loop", label: t("song.resize.option.loop") },
            { value: "stretch", label: t("song.resize.option.stretch") },
          ]}
          onChange={(value) => setMode(value as SectionResizeMode)}
        />
      ) : (
        <p style={HINT_STYLE}>
          {t("song.resize.how")}: {t("song.resize.option.trim")}
        </p>
      )}
      {valid ? null : (
        <p role="alert" style={{ ...HINT_STYLE, color: "var(--color-danger)" }}>
          {bars === dialog.currentBars ? t("song.resize.same") : t("song.resize.invalid")}
        </p>
      )}
    </Dialog>
  );
}

const FIELD_GROUP_STYLE = {
  display: "grid",
  gap: "var(--space-1)",
  marginBottom: "var(--space-3)",
} as const;

const FIELD_STYLE = {
  minHeight: "var(--size-control-md)",
  paddingInline: "var(--space-2)",
  border: "1px solid var(--color-line-strong)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface-raised)",
  color: "var(--color-text)",
  font: "inherit",
} as const;

const HINT_STYLE = {
  margin: 0,
  color: "var(--color-text-muted)",
  fontSize: "var(--text-xs)",
} as const;
