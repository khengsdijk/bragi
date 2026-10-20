// @vitest-environment jsdom
/**
 * WP-1.9 acceptance: "Accessible grid content matches the document" (12 §WP-1.9, 11 §6.1).
 *
 * The expectations are computed from the *raw document JSON* (lanes, lengthTicks, tempo), never
 * from the view model the grid is built from, so a bug in the view model cannot make the test
 * agree with itself.
 */

import type { Selection } from "@bragi/render-canvas";
import type { Project } from "@bragi/schemas";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { syntheticAnalysis } from "../api/demo-analysis.js";
import { benchmarkSpec, SHORT_DEMO } from "../api/demo-song.js";
import { buildGridModel } from "../api/grid-model.js";
import { buildCanvasDocument } from "../api/view-model.js";
import { AccessibleGrid } from "../components/AccessibleGrid.js";
import { loadDemo } from "./fixtures.js";

afterEach(cleanup);

const NOOP = {
  onSelect: () => {},
  onToggle: () => {},
  onContextMenu: () => {},
  onFocusChange: () => {},
};

async function renderGrid(
  spec = SHORT_DEMO,
  withAnalysis = true,
  handlers: Partial<typeof NOOP> = {},
) {
  const { store, model, project } = await loadDemo(spec);
  const handle = store.handle();
  const doc = store.store.getState().doc;
  if (handle === null || doc === null) throw new Error("no document");
  const view = buildCanvasDocument(model, handle, doc);
  const analysis = withAnalysis ? syntheticAnalysis(view, {}) : { stages: {} };
  const grid = buildGridModel(view, analysis);
  const selection: Selection = { kind: "none" };
  const utils = render(
    <AccessibleGrid model={grid} selection={selection} {...NOOP} {...handlers} />,
  );
  return { project, view, analysis, grid, ...utils };
}

/** Whole bars of a section, from its raw length in ticks (960 PPQ, 4/4). */
function rawBars(project: Project, index: number): number {
  const ppq = project.arrangement.timebase.ppq;
  const numerator = project.arrangement.timebase.timeSignatures[0]?.numerator ?? 4;
  return Math.round((project.arrangement.sections[index]?.lengthTicks ?? 0) / (ppq * numerator));
}

describe("the accessible grid matches the document", () => {
  it("is an ARIA grid named for the song layout", async () => {
    await renderGrid();
    const grid = screen.getByRole("grid", { name: "Song layout" });
    expect(grid).toBeTruthy();
  });

  it("has one column per section, in order, named as the document names them", async () => {
    const { project } = await renderGrid();
    const headers = screen.getAllByRole("columnheader").map((node) => node.textContent);
    expect(headers).toEqual(["Instrument", ...project.arrangement.sections.map((s) => s.label)]);
  });

  it("has a Song layout row, a Chords row and one row per visible instrument", async () => {
    const { project } = await renderGrid();
    const rowHeaders = screen
      .getAllByRole("rowheader")
      .map((node) => (node.firstChild?.textContent ?? "").trim());
    const instruments = project.tracks.filter((track) => !track.hidden).map((track) => track.name);
    expect(rowHeaders).toEqual(["Song layout", "Chords", ...instruments]);
  });

  it("omits the Chords row until the harmony stage has delivered chords", async () => {
    const { project } = await renderGrid(SHORT_DEMO, false);
    const rowHeaders = screen
      .getAllByRole("rowheader")
      .map((node) => (node.firstChild?.textContent ?? "").trim());
    expect(rowHeaders).toEqual([
      "Song layout",
      ...project.tracks.filter((t) => !t.hidden).map((t) => t.name),
    ]);
  });

  it("says, for every part, its name, its bars and its energy", async () => {
    const { project, view, analysis } = await renderGrid();
    const layoutRow = document.querySelector('[data-row-kind="layout"]');
    expect(layoutRow).not.toBeNull();
    const cells = within(layoutRow as HTMLElement).getAllByRole("gridcell");
    expect(cells).toHaveLength(project.arrangement.sections.length);
    project.arrangement.sections.forEach((section, index) => {
      const text = cells[index]?.textContent ?? "";
      const bars = rawBars(project, index);
      expect(text.startsWith(`${section.label}, ${bars} bar`)).toBe(true);
      // Energy word, from the raw energy curve over the section's span.
      const span = view.sections[index];
      const curve = analysis.energy;
      if (!span || !curve) throw new Error("missing energy");
      const from = Math.floor(span.startSec / curve.hopSec);
      const to = Math.max(from, Math.ceil(span.endSec / curve.hopSec) - 1);
      let sum = 0;
      for (let i = from; i <= to; i += 1) sum += curve.values[i] ?? 0;
      const mean = sum / (to - from + 1);
      const word = mean < 1 / 3 ? "low" : mean < 2 / 3 ? "medium" : "high";
      expect(text).toContain(`${word} energy`);
    });
    // Choruses are the loud parts of the demo, the intro is quiet.
    expect(cells[2]?.textContent).toContain("high energy");
    expect(cells[0]?.textContent).toContain("low energy");
  });

  it("says, for every instrument and part, whether the instrument is playing", async () => {
    const { project } = await renderGrid();
    for (const track of project.tracks) {
      const row = document.querySelector(`[data-row-id="${track.id}"]`);
      expect(row, track.id).not.toBeNull();
      const cells = within(row as HTMLElement).getAllByRole("gridcell");
      project.arrangement.sections.forEach((section, index) => {
        const lane = section.lanes[track.id];
        const playing = (lane?.clips.length ?? 0) > 0;
        const cell = cells[index];
        expect(cell?.getAttribute("data-playing"), `${track.name} in ${section.label}`).toBe(
          String(playing),
        );
        expect(cell?.textContent).toBe(`${track.name} ${playing ? "playing" : "silent"}`);
      });
    }
  });

  it("lists the chords of each part as text", async () => {
    const { project, view, analysis } = await renderGrid();
    const row = document.querySelector('[data-row-kind="chords"]');
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement).getAllByRole("gridcell");
    project.arrangement.sections.forEach((_section, index) => {
      const span = view.sections[index];
      if (!span) throw new Error("no span");
      const expected = (analysis.chords ?? [])
        .filter((chord) => chord.startSec >= span.startSec && chord.startSec < span.endSec)
        .map((chord) => chord.label);
      // Consecutive repeats collapse; the progression never repeats within a bar here.
      const text = cells[index]?.textContent ?? "";
      expect(text.startsWith("Chords: ")).toBe(true);
      expect(text.slice("Chords: ".length).split(" ")).toEqual(expected);
    });
  });

  it("holds for the ten-minute, twelve-instrument song too", async () => {
    const { project, grid } = await renderGrid(benchmarkSpec(10, 12));
    expect(grid.columns).toHaveLength(project.arrangement.sections.length);
    expect(screen.getAllByRole("columnheader")).toHaveLength(
      project.arrangement.sections.length + 1,
    );
    const instrumentRows = document.querySelectorAll('[data-row-kind="instrument"]');
    expect(instrumentRows).toHaveLength(12);
    for (const track of project.tracks) {
      const row = document.querySelector(`[data-row-id="${track.id}"]`);
      const cells = within(row as HTMLElement).getAllByRole("gridcell");
      project.arrangement.sections.forEach((section, index) => {
        expect(cells[index]?.getAttribute("data-playing")).toBe(
          String((section.lanes[track.id]?.clips.length ?? 0) > 0),
        );
      });
    }
  });

  it("reflects a muted instrument in its row header", async () => {
    const { store, model } = await loadDemo();
    const doc = store.store.getState().doc;
    const handle = store.handle();
    if (!doc || handle === null) throw new Error("no document");
    const muted: Project = {
      ...doc,
      tracks: doc.tracks.map((track) =>
        track.id === "trk_bass" ? { ...track, mute: true } : track,
      ),
    };
    const view = buildCanvasDocument(model, handle, muted);
    render(
      <AccessibleGrid model={buildGridModel(view, null)} selection={{ kind: "none" }} {...NOOP} />,
    );
    const row = document.querySelector('[data-row-id="trk_bass"]');
    expect(row?.querySelector('th[scope="row"]')?.textContent).toContain("Bass, muted");
    expect(screen.getByTestId("grid-mute-trk_bass").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("grid keyboard access (11 §6.2)", () => {
  it("has a single tab stop and moves with the arrow keys", async () => {
    await renderGrid();
    const cells = screen.getAllByRole("gridcell");
    const stops = cells.filter((cell) => cell.getAttribute("tabindex") === "0");
    expect(stops).toHaveLength(1);
    const first = stops[0] as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).not.toBe(first);
    expect(document.activeElement?.getAttribute("role")).toBe("gridcell");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(
      (document.activeElement as HTMLElement)
        .closest("[data-row-kind]")
        ?.getAttribute("data-row-kind"),
    ).toBe("chords");
  });

  it("selects a part with Enter and an instrument with Enter on its row", async () => {
    const onSelect = vi.fn();
    await renderGrid(SHORT_DEMO, true, { onSelect });
    const layoutCell = document.querySelector(
      '[data-row-kind="layout"] [role="gridcell"]',
    ) as HTMLElement;
    layoutCell.focus();
    fireEvent.keyDown(layoutCell, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "sections", ids: ["sec_000"] });

    const drumCell = document.querySelector(
      '[data-row-id="trk_drums"] [role="gridcell"]',
    ) as HTMLElement;
    drumCell.focus();
    fireEvent.keyDown(drumCell, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "tracks", ids: ["trk_drums"] });
    fireEvent.keyDown(drumCell, { key: "Escape" });
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "none" });
  });

  it("mutes and solos the focused instrument with M and O", async () => {
    const onToggle = vi.fn();
    await renderGrid(SHORT_DEMO, true, { onToggle });
    const cell = document.querySelector(
      '[data-row-id="trk_bass"] [role="gridcell"]',
    ) as HTMLElement;
    cell.focus();
    fireEvent.keyDown(cell, { key: "m" });
    expect(onToggle).toHaveBeenLastCalledWith("trk_bass", "mute");
    fireEvent.keyDown(cell, { key: "o" });
    expect(onToggle).toHaveBeenLastCalledWith("trk_bass", "solo");
    // On the Song layout row there is nothing to mute.
    const layoutCell = document.querySelector(
      '[data-row-kind="layout"] [role="gridcell"]',
    ) as HTMLElement;
    onToggle.mockClear();
    fireEvent.keyDown(layoutCell, { key: "m" });
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("offers real mute and solo buttons with names and pressed state", async () => {
    const onToggle = vi.fn();
    await renderGrid(SHORT_DEMO, true, { onToggle });
    const mute = screen.getByRole("button", { name: "Mute Drums" });
    fireEvent.click(mute);
    expect(onToggle).toHaveBeenCalledWith("trk_drums", "mute");
    expect(screen.getByRole("button", { name: "Solo Bass" })).toBeTruthy();
  });

  it("leaves modified keys to the workspace (Alt+arrows, Cmd/Ctrl+K)", async () => {
    await renderGrid();
    const cell = document.querySelector(
      '[data-row-kind="layout"] [role="gridcell"]',
    ) as HTMLElement;
    cell.focus();
    // `fireEvent` returns false when a handler called preventDefault.
    expect(fireEvent.keyDown(cell, { key: "ArrowRight", altKey: true })).toBe(true);
    expect(document.activeElement).toBe(cell);
    expect(fireEvent.keyDown(cell, { key: "k", ctrlKey: true })).toBe(true);
    expect(document.activeElement).toBe(cell);
  });

  it("opens the section menu with Shift+F10, the context-menu key or a right-click", async () => {
    const onContextMenu = vi.fn();
    await renderGrid(SHORT_DEMO, true, { onContextMenu });
    const cell = document.querySelector(
      '[data-row-kind="layout"] [role="gridcell"]:nth-child(4)',
    ) as HTMLElement;
    cell.focus();

    fireEvent.keyDown(cell, { key: "F10", shiftKey: true });
    expect(onContextMenu).toHaveBeenLastCalledWith("sec_002", cell);
    fireEvent.keyDown(cell, { key: "ContextMenu" });
    expect(onContextMenu).toHaveBeenLastCalledWith("sec_002", cell);

    onContextMenu.mockClear();
    fireEvent.contextMenu(cell);
    expect(onContextMenu).toHaveBeenCalledWith("sec_002", cell);
    // Plain F10 belongs to the browser.
    fireEvent.keyDown(cell, { key: "F10" });
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });

  it("reports focus so the canvas can draw its ring, and clears it on blur", async () => {
    const onFocusChange = vi.fn();
    await renderGrid(SHORT_DEMO, true, { onFocusChange });
    const cell = document.querySelector(
      '[data-row-id="trk_pads"] [role="gridcell"]',
    ) as HTMLElement;
    cell.focus();
    expect(onFocusChange).toHaveBeenLastCalledWith({ kind: "track", id: "trk_pads" });
    const layoutCell = document.querySelector(
      '[data-row-kind="layout"] [role="gridcell"]:nth-child(3)',
    ) as HTMLElement;
    layoutCell.focus();
    expect(onFocusChange).toHaveBeenLastCalledWith({ kind: "section", id: "sec_001" });
    cell.blur();
    layoutCell.blur();
    expect(onFocusChange).toHaveBeenLastCalledWith(null);
  });
});
