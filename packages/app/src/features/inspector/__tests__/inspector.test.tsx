// @vitest-environment jsdom
/**
 * WP-2.3 task D: the Inspector's track/master controls, vibe sliders and expert drawer, wired to
 * the real history store. Every edit is checked against the document and the commit count, so an
 * accidental extra commit (or a drag that mutates the document early) fails.
 */
import type { Project } from "@bragi/schemas";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Inspector } from "../components/Inspector.js";
import { type InspectorFixture, liveDoc, openInspectorFixture } from "./fixture.js";

afterEach(cleanup);

const DRUMS = { kind: "tracks", ids: ["trk_drums"] } as const;

interface Rendered extends InspectorFixture {
  readonly onCommit: ReturnType<typeof vi.fn>;
  readonly onAnnounce: ReturnType<typeof vi.fn>;
}

async function renderInspector(
  selection:
    | { readonly kind: "tracks"; readonly ids: readonly string[] }
    | { readonly kind: "none" } = DRUMS,
): Promise<Rendered> {
  const fixture = await openInspectorFixture();
  const onCommit = vi.fn();
  const onAnnounce = vi.fn();
  render(
    <Inspector
      songStore={fixture.store}
      history={fixture.history}
      onCommit={onCommit}
      selection={selection}
      onClose={() => {}}
      onAnnounce={onAnnounce}
    />,
  );
  return { ...fixture, onCommit, onAnnounce };
}

function commitCount(fixture: InspectorFixture): number {
  return fixture.history.store.getState().commits.size;
}

function trackDoc(fixture: InspectorFixture, id = "trk_drums"): Project["tracks"][number] {
  const track = liveDoc(fixture).tracks.find((candidate) => candidate.id === id);
  if (track === undefined) throw new Error(`no track ${id}`);
  return track;
}

function sliderRoot(name: string): HTMLElement {
  const thumb = screen.getByRole("slider", { name });
  const root = [...document.querySelectorAll<HTMLElement>('[data-orientation="horizontal"]')].find(
    (candidate) => candidate !== thumb && candidate.contains(thumb),
  );
  if (root === undefined) throw new Error(`no slider root for ${name}`);
  return root;
}

/** Drags a Radix slider across a 200 px track in jsdom. */
function drag(name: string, from: number, to: number): void {
  const root = sliderRoot(name);
  root.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 200,
      height: 32,
      right: 200,
      bottom: 32,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  fireEvent.pointerDown(root, { clientX: from * 200, pointerId: 1, button: 0 });
  fireEvent.pointerMove(root, { clientX: to * 200, pointerId: 1 });
  fireEvent.pointerUp(root, { clientX: to * 200, pointerId: 1 });
}

function cardFor(name: string): HTMLElement {
  const heading = screen.getByRole("heading", { name, level: 4 });
  const card = heading.closest("article");
  if (card === null) throw new Error(`no card for ${name}`);
  return card as HTMLElement;
}

function batchLabel(fixture: InspectorFixture): string | null {
  const head = fixture.history.store.getState().head;
  return head === null ? null : (fixture.history.store.getState().commits.get(head)?.label ?? null);
}

describe("Inspector — track", () => {
  it("opens for a selected instrument with its mixer and the six vibe sliders", async () => {
    await renderInspector();
    expect(screen.getByRole("heading", { name: "Drums" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Volume" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Pan" })).toBeTruthy();
    for (const name of ["Brightness", "Space", "Punch", "Warmth", "Vintage", "Distance"]) {
      expect(screen.getByRole("slider", { name }), name).toBeTruthy();
    }
    // 03 §6.1 defines intensity, but 07 §4.5 does not put it on the track inspector.
    expect(screen.queryByRole("slider", { name: "Intensity" })).toBeNull();
  });

  it("mutes and solos with one commit each, and undo/redo move the button back", async () => {
    const fixture = await renderInspector();
    const start = commitCount(fixture);

    await userEvent.click(screen.getByRole("button", { name: "Mute Drums" }));
    await waitFor(() => expect(commitCount(fixture)).toBe(start + 1));
    expect(trackDoc(fixture).mute).toBe(true);
    expect(batchLabel(fixture)).toBe("Mute Drums");
    expect(screen.getByRole("button", { name: "Unmute Drums" }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    await act(async () => {
      await fixture.history.undo();
    });
    await waitFor(() => expect(trackDoc(fixture).mute).toBe(false));
    expect(screen.getByRole("button", { name: "Mute Drums" })).toBeTruthy();

    await act(async () => {
      await fixture.history.redo();
    });
    await waitFor(() => expect(trackDoc(fixture).mute).toBe(true));

    await userEvent.click(screen.getByRole("button", { name: "Solo Drums" }));
    await waitFor(() => expect(trackDoc(fixture).solo).toBe(true));
    expect(batchLabel(fixture)).toBe("Solo Drums");
  });

  it("commits a volume drag once and reads the value back after undo", async () => {
    const fixture = await renderInspector();
    const start = commitCount(fixture);

    drag("Volume", 60 / 72, 54 / 72);
    await waitFor(() => expect(commitCount(fixture)).toBe(start + 1));
    expect(trackDoc(fixture).gainDb).toBeCloseTo(-6, 0);
    expect(batchLabel(fixture)).toBe("Volume on Drums");
    expect(screen.getByRole("slider", { name: "Volume" }).getAttribute("aria-valuetext")).toBe(
      "−6.0 dB",
    );

    await act(async () => {
      await fixture.history.undo();
    });
    await waitFor(() => expect(trackDoc(fixture).gainDb).toBe(0));
    expect(screen.getByRole("slider", { name: "Volume" }).getAttribute("aria-valuetext")).toBe(
      "0.0 dB",
    );
  });

  it("commits each keyboard step as its own edit", async () => {
    const fixture = await renderInspector();
    const start = commitCount(fixture);
    const thumb = screen.getByRole("slider", { name: "Volume" });
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    await waitFor(() => expect(commitCount(fixture)).toBe(start + 1));
    expect(trackDoc(fixture).gainDb).toBeCloseTo(0.1, 5);
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    await waitFor(() => expect(commitCount(fixture)).toBe(start + 2));
    expect(trackDoc(fixture).gainDb).toBeCloseTo(0.2, 5);
  });

  it("adds macro-owned effects in one commit, and the slider reads back after undo and redo", async () => {
    const fixture = await renderInspector();
    const start = commitCount(fixture);

    drag("Brightness", 0.5, 0.75);
    await waitFor(() => expect(commitCount(fixture)).toBe(start + 1));
    const owned = trackDoc(fixture).fx.filter((fx) => fx.macroOwned === "brightness");
    expect(owned.map((fx) => fx.type).sort()).toEqual(["eq3", "filter"]);
    expect(batchLabel(fixture)).toBe("Brightness on Drums");
    expect(screen.getByRole("slider", { name: "Brightness" }).getAttribute("aria-valuenow")).toBe(
      "0.5",
    );

    await act(async () => {
      await fixture.history.undo();
    });
    await waitFor(() =>
      expect(screen.getByRole("slider", { name: "Brightness" }).getAttribute("aria-valuenow")).toBe(
        "0",
      ),
    );

    await act(async () => {
      await fixture.history.redo();
    });
    await waitFor(() =>
      expect(screen.getByRole("slider", { name: "Brightness" }).getAttribute("aria-valuenow")).toBe(
        "0.5",
      ),
    );
  });

  it("moves the vibe slider when its driven parameter is edited in the expert drawer", async () => {
    const fixture = await renderInspector();
    drag("Brightness", 0.5, 0.75);
    await waitFor(() => expect(commitCount(fixture)).toBe(2));

    await userEvent.click(screen.getByRole("button", { name: "Expert" }));
    const high = within(cardFor("EQ")).getByRole("slider", { name: "High" });
    fireEvent.keyDown(high, { key: "ArrowRight" });
    await waitFor(() => expect(commitCount(fixture)).toBe(3));
    expect(batchLabel(fixture)).toBe("Change High on EQ");

    const brightness = Number(
      screen.getByRole("slider", { name: "Brightness" }).getAttribute("aria-valuenow"),
    );
    expect(brightness).toBeGreaterThan(0.5);
  });
});

describe("Inspector — expert drawer", () => {
  it("adds, bypasses, reorders and removes effects, each as one undoable commit", async () => {
    const fixture = await renderInspector();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Expert" }));
    expect(screen.getByRole("button", { name: "Expert" }).getAttribute("aria-expanded")).toBe(
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Add effect" }));
    // The limiter is master-only; Match EQ is system-generated.
    expect(screen.queryByRole("menuitem", { name: "Limiter" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Match EQ" })).toBeNull();
    await user.click(await screen.findByRole("menuitem", { name: "Reverb" }));
    await waitFor(() => expect(trackDoc(fixture).fx).toHaveLength(1));
    expect(batchLabel(fixture)).toBe("Add Reverb");

    await user.click(screen.getByRole("button", { name: "Add effect" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delay" }));
    await waitFor(() => expect(trackDoc(fixture).fx).toHaveLength(2));
    expect(trackDoc(fixture).fx.map((fx) => fx.type)).toEqual(["reverb", "delay"]);

    await user.click(within(cardFor("Reverb")).getByRole("button", { name: "Bypass" }));
    await waitFor(() =>
      expect(trackDoc(fixture).fx.find((fx) => fx.type === "reverb")?.bypass).toBe(true),
    );

    await user.click(screen.getByRole("button", { name: "Move Delay up" }));
    await waitFor(() =>
      expect(trackDoc(fixture).fx.map((fx) => fx.type)).toEqual(["delay", "reverb"]),
    );

    await user.click(screen.getByRole("button", { name: "Remove Reverb" }));
    await waitFor(() => expect(trackDoc(fixture).fx.map((fx) => fx.type)).toEqual(["delay"]));
    expect(batchLabel(fixture)).toBe("Remove Reverb");

    await act(async () => {
      await fixture.history.undo();
    });
    await waitFor(() =>
      expect(trackDoc(fixture).fx.map((fx) => fx.type)).toEqual(["delay", "reverb"]),
    );
  });

  it("writes the sidechain source through fx.update", async () => {
    const fixture = await renderInspector();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Expert" }));
    await user.click(screen.getByRole("button", { name: "Add effect" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sidechain duck" }));
    await waitFor(() =>
      expect(trackDoc(fixture).fx.some((fx) => fx.type === "sidechain_duck")).toBe(true),
    );

    const duck = trackDoc(fixture).fx.find((fx) => fx.type === "sidechain_duck");
    if (duck === undefined) throw new Error("no sidechain duck");
    const select = within(cardFor("Sidechain duck")).getByRole("combobox", { name: "Source" });
    await user.selectOptions(select, "trk_bass");
    await waitFor(() =>
      expect(trackDoc(fixture).fx.find((fx) => fx.id === duck.id)?.sidechainSource).toBe(
        "trk_bass",
      ),
    );
    expect(batchLabel(fixture)).toBe("Sidechain for Sidechain duck");
  });

  it("shows the catalogue's discrete mode as a segmented control", async () => {
    const fixture = await renderInspector();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Expert" }));
    await user.click(screen.getByRole("button", { name: "Add effect" }));
    await user.click(await screen.findByRole("menuitem", { name: "Filter" }));
    await waitFor(() => expect(trackDoc(fixture).fx).toHaveLength(1));

    const card = cardFor("Filter");
    expect(within(card).getByRole("group", { name: "Mode" })).toBeTruthy();
    await user.click(within(card).getByRole("radio", { name: "High-pass" }));
    await waitFor(() =>
      expect(trackDoc(fixture).fx.find((fx) => fx.type === "filter")?.params.mode).toBe(1),
    );
  });
});

describe("Inspector — master", () => {
  it("shows the master chain, offers the master-only limiter and master vibe sliders", async () => {
    await renderInspector({ kind: "none" });
    expect(screen.getByRole("heading", { name: "Master" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Brightness" })).toBeTruthy();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Expert" }));
    await user.click(screen.getByRole("button", { name: "Add effect" }));
    const limiter = await screen.findByRole("menuitem", { name: "Limiter" });
    expect(limiter).toBeTruthy();
    // `match_eq` is system-generated and never offered.
    expect(screen.queryByRole("menuitem", { name: "Match EQ" })).toBeNull();
  });

  it("adds an effect to the master chain, not a track", async () => {
    const fixture = await renderInspector({ kind: "none" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Expert" }));
    await user.click(screen.getByRole("button", { name: "Add effect" }));
    await user.click(await screen.findByRole("menuitem", { name: "Limiter" }));
    await waitFor(() => expect(liveDoc(fixture).arrangement.master.fx).toHaveLength(1));
    expect(batchLabel(fixture)).toBe("Add Limiter");
    for (const track of liveDoc(fixture).tracks) expect(track.fx).toHaveLength(0);
  });
});
