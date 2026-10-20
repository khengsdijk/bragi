/**
 * The Inspector's expert drawer (07 §4.5, §5 in 11): the chain in order with catalogue-generated
 * controls. Nothing here restates a range or a default — `FX_CATALOG` supplies them, so a new
 * effect kind appears as soon as it has a name and a parameter label.
 */
import { Button, Chip, IconButton, Menu, MenuItem, SegmentedControl, Slider } from "@bragi/design";
import type {
  CatalogFxDefinition,
  CatalogNumberParam,
  FxInstance,
  FxScope,
  FxType,
  OpBatch,
  Track,
} from "@bragi/schemas";
import { FX_CATALOG } from "@bragi/schemas";
import type { RefObject } from "react";

import { t } from "../../../i18n/index.js";
import {
  fxAddBatch,
  fxBypassBatch,
  fxMoveBatch,
  fxParamBatch,
  fxRemoveBatch,
  fxSidechainBatch,
} from "../api/batches.js";
import { formatParamValue, isModeParam, paramStep } from "../format.js";
import { effectName, macroName, modeName, paramName } from "../labels.js";
import { catalogueDefaults } from "../macros.js";
import type { GestureEdit } from "../types.js";

export interface ExpertDrawerProps {
  readonly scope: FxScope;
  readonly chain: readonly FxInstance[];
  readonly tracks: readonly Track[];
  /** The track's id when the chain belongs to a track; `null` on the master. */
  readonly trackId: string | null;
  readonly edit: GestureEdit;
  readonly apply: (batch: OpBatch | null) => void;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  /** The disclosure's `aria-controls` target. */
  readonly contentId: string;
}

/** The catalogue kinds offered by "Add effect": everything except system and track-only misses. */
function addableKinds(master: boolean): readonly FxType[] {
  const kinds: FxType[] = [];
  for (const [type, definition] of Object.entries(FX_CATALOG.fx)) {
    if (definition.system === true) continue;
    if (!master && definition.masterOnly === true) continue;
    kinds.push(type as FxType);
  }
  return kinds;
}

/** A numeric catalogue parameter, narrowed for the slider. */
function definitionOf(fx: FxInstance): CatalogFxDefinition | undefined {
  return FX_CATALOG.fx[fx.type];
}

export function ExpertDrawer({
  scope,
  chain,
  tracks,
  trackId,
  edit,
  apply,
  open,
  onToggle,
  headingRef,
  contentId,
}: ExpertDrawerProps) {
  const master = scope.kind === "master";

  return (
    <section aria-labelledby="inspector-expert-heading" data-testid="inspector-expert">
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <h3
          id="inspector-expert-heading"
          ref={headingRef}
          tabIndex={-1}
          style={{ margin: 0, fontSize: "var(--text-base)" }}
        >
          {t("inspector.expert")}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={onToggle}
        >
          {t("inspector.expert")}
        </Button>
      </div>
      <p style={{ margin: "var(--space-1) 0 0", color: "var(--color-text-muted)" }}>
        {t("inspector.expert.hint")}
      </p>

      <div id={contentId} hidden={!open}>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            paddingBlock: "var(--space-2)",
          }}
        >
          <Menu
            label={t("inspector.addEffect")}
            modal={false}
            trigger={
              <Button variant="secondary" size="sm">
                {t("inspector.addEffect")}
              </Button>
            }
          >
            {addableKinds(master).map((type) => (
              <MenuItem
                key={type}
                onSelect={() => apply(fxAddBatch(scope, type, catalogueDefaults(type)))}
              >
                {effectName(type)}
              </MenuItem>
            ))}
          </Menu>
        </div>

        {chain.length === 0 ? (
          <p style={{ margin: 0, color: "var(--color-text-muted)" }}>
            {t("inspector.expert.empty")}
          </p>
        ) : (
          <ol
            aria-label={t("inspector.expert.chain")}
            style={{
              display: "grid",
              gap: "var(--space-2)",
              margin: 0,
              padding: 0,
              listStyle: "none",
            }}
          >
            {chain.map((fx, index) => (
              <li key={fx.id}>
                <FxCard
                  fx={fx}
                  index={index}
                  length={chain.length}
                  tracks={tracks}
                  trackId={trackId}
                  edit={edit}
                  apply={apply}
                />
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

interface FxCardProps {
  readonly fx: FxInstance;
  readonly index: number;
  readonly length: number;
  readonly tracks: readonly Track[];
  readonly trackId: string | null;
  readonly edit: GestureEdit;
  readonly apply: (batch: OpBatch | null) => void;
}

function FxCard({ fx, index, length, tracks, trackId, edit, apply }: FxCardProps) {
  const headingId = `fx-${fx.id}-title`;
  const definition = definitionOf(fx);
  const params = definition === undefined ? [] : Object.entries(definition.params);
  const macroNameText = fx.macroOwned === undefined ? null : macroName(fx.macroOwned);
  const sources = tracks.filter((track) => track.id !== trackId);

  return (
    <article
      aria-labelledby={headingId}
      data-testid={`fx-card-${fx.id}`}
      style={{
        display: "grid",
        gap: "var(--space-2)",
        padding: "var(--space-2)",
        border: "1px solid var(--color-line)",
        borderRadius: "var(--radius-md)",
        background: "var(--color-surface-raised)",
        opacity: fx.bypass ? 0.65 : 1,
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <h4 id={headingId} style={{ margin: 0, fontSize: "var(--text-sm)" }}>
          {effectName(fx.type)}
        </h4>
        {macroNameText === null ? null : (
          <Chip tone="accent">{t("inspector.controlledBy", { macro: macroNameText })}</Chip>
        )}
        <span style={{ flex: 1 }} />
        <Button
          variant={fx.bypass ? "primary" : "secondary"}
          size="sm"
          aria-pressed={fx.bypass}
          onClick={() => apply(fxBypassBatch(fx, !fx.bypass))}
        >
          {t("inspector.fx.bypass")}
        </Button>
        <IconButton
          label={t("inspector.fx.moveUp", { name: effectName(fx.type) })}
          size="sm"
          disabled={index === 0}
          onClick={() => apply(fxMoveBatch(fx, index - 1))}
        >
          <span aria-hidden="true">↑</span>
        </IconButton>
        <IconButton
          label={t("inspector.fx.moveDown", { name: effectName(fx.type) })}
          size="sm"
          disabled={index === length - 1}
          onClick={() => apply(fxMoveBatch(fx, index + 1))}
        >
          <span aria-hidden="true">↓</span>
        </IconButton>
        <IconButton
          label={t("inspector.fx.remove", { name: effectName(fx.type) })}
          size="sm"
          onClick={() => apply(fxRemoveBatch(fx))}
        >
          <span aria-hidden="true">×</span>
        </IconButton>
      </header>

      {params.length === 0 ? (
        <p style={{ margin: 0, color: "var(--color-text-muted)" }}>
          {t("inspector.expert.noParams")}
        </p>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          {params.map(([name, spec]) => {
            if (spec.type === "number") {
              return (
                <NumericParam
                  key={name}
                  fx={fx}
                  name={name}
                  spec={spec}
                  edit={edit}
                  apply={apply}
                />
              );
            }
            if (spec.type === "trackId") {
              return fx.type === "sidechain_duck" ? (
                <SidechainSelect key={name} fx={fx} sources={sources} apply={apply} />
              ) : null;
            }
            return (
              <p key={name} style={{ margin: 0, color: "var(--color-text-muted)" }}>
                {fx.type === "match_eq"
                  ? t("inspector.matchBands")
                  : t("inspector.expert.systemParam")}
              </p>
            );
          })}
        </div>
      )}
    </article>
  );
}

interface NumericParamProps {
  readonly fx: FxInstance;
  readonly name: string;
  readonly spec: CatalogNumberParam;
  readonly edit: GestureEdit;
  readonly apply: (batch: OpBatch | null) => void;
}

function NumericParam({ fx, name, spec, edit, apply }: NumericParamProps) {
  const value = fx.params[name] ?? spec.default;
  const label = paramName(name);

  if (isModeParam(name, spec)) {
    const options = [];
    for (let index = spec.min; index <= spec.max; index += 1) {
      options.push({ value: String(index), label: modeName(fx.type, index) });
    }
    return (
      <SegmentedControl
        label={label}
        value={String(Math.round(value))}
        options={options}
        onChange={(next) => {
          const numeric = Number(next);
          if (Number.isFinite(numeric)) apply(fxParamBatch(fx, name, numeric));
        }}
      />
    );
  }

  const step = paramStep(name, spec);
  return (
    <Slider
      label={label}
      min={spec.min}
      max={spec.max}
      step={step}
      value={value}
      showValue
      formatValue={(next) => formatParamValue(name, next, spec)}
      onValueChange={(next) => edit.step(next, () => fxParamBatch(fx, name, next))}
      onValueCommit={(next) => edit.finish(next, () => fxParamBatch(fx, name, next))}
    />
  );
}

interface SidechainSelectProps {
  readonly fx: FxInstance;
  readonly sources: readonly Track[];
  readonly apply: (batch: OpBatch | null) => void;
}

function SidechainSelect({ fx, sources, apply }: SidechainSelectProps) {
  return (
    <label style={{ display: "grid", gap: "var(--space-1)", fontSize: "var(--text-xs)" }}>
      <span style={{ color: "var(--color-text-muted)" }}>{paramName("sourceTrack")}</span>
      <select
        value={fx.sidechainSource ?? ""}
        onChange={(event) =>
          apply(fxSidechainBatch(fx, event.target.value === "" ? null : event.target.value))
        }
        style={{
          minHeight: "var(--size-control-md)",
          paddingInline: "var(--space-2)",
          border: "1px solid var(--color-line-strong)",
          borderRadius: "var(--radius-sm)",
          background: "var(--color-surface)",
          color: "var(--color-text)",
          font: "inherit",
        }}
      >
        <option value="">{t("inspector.sidechain.none")}</option>
        {sources.map((track) => (
          <option key={track.id} value={track.id}>
            {track.name}
          </option>
        ))}
      </select>
    </label>
  );
}
