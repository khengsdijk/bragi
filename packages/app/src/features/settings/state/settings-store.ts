/**
 * The device settings store (11 §9, 07 §4.1).
 *
 * `smartTransitions` decides whether a move or a remove adds one-beat crossfades (02 §5.1). The
 * value is read from `local_settings` once and written back optimistically: the toggle takes
 * effect immediately, and a failed write leaves the session usable.
 */
import type { LocalDB } from "@bragi/platform";
import { createStore, type StoreApi } from "zustand/vanilla";

import { readSmartTransitions, writeSmartTransitions } from "../api/settings-repo.js";

export interface SettingsState {
  /** Add crossfades at the joins a section move or remove creates. Default on. */
  readonly smartTransitions: boolean;
  /** Whether the stored value has been read; the default is used until then. */
  readonly loaded: boolean;
}

export interface SettingsStore {
  readonly store: StoreApi<SettingsState>;
  /** Reads the stored settings; safe to call more than once. */
  load(): Promise<void>;
  /** Writes `smartTransitions` and updates the view immediately. */
  setSmartTransitions(value: boolean): Promise<void>;
}

/** Creates the store; without a database it is in-memory with the defaults. */
export function createSettingsStore(db?: LocalDB): SettingsStore {
  const store = createStore<SettingsState>(() => ({
    smartTransitions: true,
    loaded: db === undefined,
  }));
  let loading: Promise<void> | null = null;

  const persist = async (task: () => Promise<void>): Promise<void> => {
    try {
      await task();
    } catch (cause) {
      // The in-memory value already changed; the next load falls back to the stored one.
      console.warn("could not save a setting", cause);
    }
  };

  return {
    store,
    load() {
      if (db === undefined) return Promise.resolve();
      loading ??= readSmartTransitions(db)
        .then((smartTransitions) => store.setState({ smartTransitions, loaded: true }))
        .catch((cause: unknown) => {
          console.warn("could not read the settings", cause);
          store.setState({ loaded: true });
        })
        .finally(() => {
          loading = null;
        });
      return loading;
    },
    async setSmartTransitions(value) {
      store.setState({ smartTransitions: value });
      if (db !== undefined) await persist(() => writeSmartTransitions(db, value));
    },
  };
}
