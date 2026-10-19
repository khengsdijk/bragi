/**
 * The transport bar (07 §1): back to start, play/pause, position, loop and zoom, wired to the
 * `EngineController` and the canvas. Every control is a real button or slider, so the whole bar
 * is keyboard reachable with no canvas involved.
 */
import { Button, Icon, IconButton, Slider } from "@bragi/design";
import type { ZoomLevel } from "@bragi/render-canvas";
import type { ReactNode } from "react";
import { useStore } from "zustand";

import { type MessageKey, t } from "../../../i18n/index.js";
import type { EngineController } from "../state/engine-controller.js";

/** `mm:ss.t`, e.g. `01:12.4`. */
export function formatTime(sec: number): string {
  const clamped = Math.max(0, sec);
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped - minutes * 60;
  const whole = Math.floor(seconds);
  const tenth = Math.floor((seconds - whole) * 10);
  return `${String(minutes).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${tenth}`;
}

export interface TransportBarProps {
  readonly controller: EngineController;
  readonly level: ZoomLevel;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onFit: () => void;
}

export function TransportBar({
  controller,
  level,
  onZoomIn,
  onZoomOut,
  onFit,
}: TransportBarProps): ReactNode {
  const state = useStore(controller.store);
  const unavailable = state.status === "unavailable";
  const fraction = state.durationSec > 0 ? state.positionSec / state.durationSec : 0;
  const position = formatTime(state.positionSec);
  const duration = formatTime(state.durationSec);

  return (
    <section className="transport" aria-label={t("transport.label")} data-testid="transport">
      <IconButton
        label={t("transport.start")}
        onClick={() => controller.toStart()}
        disabled={unavailable}
      >
        <Icon>
          <path d="M4 3v10M13 3L6.5 8 13 13z" />
        </Icon>
      </IconButton>
      <IconButton
        label={state.playing ? t("transport.pause") : t("transport.play")}
        variant="primary"
        loading={state.status === "starting"}
        disabled={unavailable}
        onClick={() => void controller.toggle()}
      >
        <Icon>{state.playing ? <path d="M5 3v10M11 3v10" /> : <path d="M5 3l8 5-8 5z" />}</Icon>
      </IconButton>
      <div className="transport__position">
        <Slider
          label={t("transport.position")}
          value={Math.min(1, Math.max(0, fraction))}
          step={0.001}
          disabled={unavailable}
          onValueChange={(value) => controller.seek(value * state.durationSec)}
          formatValue={() => t("transport.time", { position, duration })}
        />
      </div>
      <output className="transport__time" data-testid="transport-time" aria-live="off">
        {t("transport.time", { position, duration })}
      </output>
      <Button
        variant={state.loop ? "secondary" : "ghost"}
        size="sm"
        aria-pressed={state.loop}
        disabled={unavailable}
        onClick={() => controller.setLoop(!state.loop)}
      >
        {t("transport.loop")}
      </Button>
      <fieldset className="transport__zoom">
        <legend className="sr-only">{t("song.zoom.label")}</legend>
        <IconButton label={t("song.zoom.out")} size="sm" onClick={onZoomOut}>
          <Icon>
            <path d="M3 8h10" />
          </Icon>
        </IconButton>
        <IconButton label={t("song.zoom.in")} size="sm" onClick={onZoomIn}>
          <Icon>
            <path d="M3 8h10M8 3v10" />
          </Icon>
        </IconButton>
        <Button variant="ghost" size="sm" onClick={onFit}>
          {t("song.zoom.fit")}
        </Button>
        <span className="transport__level" data-testid="zoom-level">
          {t(`song.zoom.level.${level}` as MessageKey)}
        </span>
      </fieldset>
      {unavailable ? (
        <p className="transport__note" role="status">
          {t("transport.unavailable")}
        </p>
      ) : null}
      {state.status === "error" ? (
        <p className="transport__note" role="alert" data-testid="transport-error">
          {t("transport.error")}
        </p>
      ) : null}
    </section>
  );
}
