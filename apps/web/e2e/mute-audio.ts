/**
 * Silences the e2e browsers' speakers without stopping their audio clocks.
 *
 * The playback specs need a running `AudioContext` (its `currentTime` and the engine's playhead
 * must advance), so the graph keeps rendering; only the last hop to the speakers goes through a
 * gain of 0. Analysers and worklets upstream see the same signal as before. `BRAGI_E2E_AUDIBLE=1`
 * turns this off for a run you want to hear.
 */
import type { BrowserContext } from "@playwright/test";

/** Whether this run mutes the browsers (the default). */
export const MUTED = process.env.BRAGI_E2E_AUDIBLE !== "1";

/** Runs in every page before the app: routes `connect(destination)` through a muted gain. */
function muteWebAudio(): void {
  const scope = globalThis as typeof globalThis & { __bragiMuted?: boolean };
  if (scope.__bragiMuted === true || typeof AudioNode === "undefined") return;
  scope.__bragiMuted = true;
  const mutes = new WeakMap<BaseAudioContext, GainNode>();
  const connect = AudioNode.prototype.connect as (
    this: AudioNode,
    destination: AudioNode | AudioParam,
    ...rest: number[]
  ) => AudioNode | undefined;
  const disconnect = AudioNode.prototype.disconnect as (
    this: AudioNode,
    ...args: unknown[]
  ) => void;
  const muteFor = (context: BaseAudioContext): GainNode => {
    let gain = mutes.get(context);
    if (gain === undefined) {
      gain = context.createGain();
      gain.gain.value = 0;
      connect.call(gain, context.destination);
      mutes.set(context, gain);
    }
    return gain;
  };
  AudioNode.prototype.connect = function (
    this: AudioNode,
    destination: AudioNode | AudioParam,
    ...rest: number[]
  ) {
    if (destination instanceof AudioDestinationNode) {
      connect.call(this, muteFor(destination.context), ...rest);
      return destination;
    }
    return connect.call(this, destination, ...rest);
  } as typeof AudioNode.prototype.connect;
  AudioNode.prototype.disconnect = function (this: AudioNode, ...args: unknown[]) {
    const [target, ...rest] = args;
    if (target instanceof AudioDestinationNode) {
      disconnect.call(this, muteFor(target.context), ...rest);
      return;
    }
    disconnect.apply(this, args);
  } as typeof AudioNode.prototype.disconnect;
  if (typeof HTMLMediaElement !== "undefined") {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      this.muted = true;
      return play.call(this);
    };
  }
}

/** Mutes every page of a context (no-op with `BRAGI_E2E_AUDIBLE=1`). */
export async function muteContext(context: BrowserContext): Promise<void> {
  if (MUTED) await context.addInitScript(muteWebAudio);
}
