// @vitest-environment jsdom
/**
 * The keyboard brush action (11 §6.2): a whole part becomes one region on the chosen tracks and
 * commits through the same path as the section actions.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { useMemo } from "react";
import { describe, expect, it, vi } from "vitest";

import { createSettingsStore } from "../../settings/state/settings-store.js";
import { useSongActions } from "../../song/hooks/use-song-actions.js";
import { createEngineController } from "../../song/state/engine-controller.js";
import { documentOf, openBrushFixture } from "./fixtures.js";

describe("apply brush action", () => {
  it("paints a part's full span on the chosen tracks in one commit", async () => {
    const fixture = await openBrushFixture();
    await fixture.history.load();
    const announce = vi.fn<(message: string) => void>();
    const controller = createEngineController({
      document: () => fixture.store.store.getState().doc,
      durationSec: () => 32,
    });
    const { result } = renderHook(() => {
      const settings = useMemo(() => createSettingsStore(), []);
      return useSongActions({
        songStore: fixture.store,
        controller,
        settings,
        history: fixture.history,
        model: fixture.model,
        selection: { kind: "sections", ids: ["sec_001"] },
        focus: null,
        historyOpen: false,
        explainMode: false,
        onAskAi: () => {},
        onToggleExplain: () => {},
        onToggleHistory: () => {},
        onAnnounce: announce,
      });
    });

    act(() => {
      result.current.applyBrush("sec_001", "space", ["trk_drums"], 0.6, "up");
    });
    await waitFor(() => expect(fixture.history.store.getState().commits.size).toBe(2));

    const batch = [...fixture.history.store.getState().commits.values()].at(-1)?.batch;
    expect(batch?.label).toBe("Space on Drums, bars 3–6");
    expect(announce).toHaveBeenCalledWith("Space on Drums, bars 3–6");
    const section = documentOf(fixture).arrangement.sections[1];
    expect(section?.lanes.trk_drums?.automation.length).toBeGreaterThan(0);
    expect(section?.lanes.trk_bass?.automation ?? []).toHaveLength(0);
  });

  it("announces when a part has no track to paint", async () => {
    const fixture = await openBrushFixture();
    await fixture.history.load();
    const announce = vi.fn<(message: string) => void>();
    const controller = createEngineController({
      document: () => fixture.store.store.getState().doc,
      durationSec: () => 32,
    });
    const { result } = renderHook(() => {
      const settings = useMemo(() => createSettingsStore(), []);
      return useSongActions({
        songStore: fixture.store,
        controller,
        settings,
        history: fixture.history,
        model: fixture.model,
        selection: { kind: "sections", ids: ["sec_001"] },
        focus: null,
        historyOpen: false,
        explainMode: false,
        onAskAi: () => {},
        onToggleExplain: () => {},
        onToggleHistory: () => {},
        onAnnounce: announce,
      });
    });

    act(() => {
      result.current.applyBrush("sec_001", "space", [], 0.6, "up");
    });
    expect(announce).toHaveBeenCalledWith("Nothing to paint there. The song is unchanged.");
    expect(fixture.history.store.getState().commits.size).toBe(1);
  });
});
