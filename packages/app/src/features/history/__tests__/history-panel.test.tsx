// @vitest-environment jsdom
/**
 * WP-2.1: the history panel's tree, keyboard and per-version actions (07 §7).
 *
 * These tests run against {@link fakeHistory} rather than the local database: the panel is a view
 * over `History.store`, and the fake keeps that contract (checkout moves HEAD, naming adds a
 * branch ref) without the model round-trips the store tests already cover. The real `bragi-model`
 * is loaded for `regionBoundariesAlign`, which is the one computation the panel does itself.
 */
import type { Selection } from "@bragi/render-canvas";
import type { Project } from "@bragi/schemas";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { t } from "../../../i18n/index.js";
import { loadTestModel } from "../../song/__tests__/fixtures.js";
import { buildDemoProject, fakeAssetHash, SHORT_DEMO } from "../../song/api/demo-song.js";
import type { ModelApi } from "../../song/model/model-api.js";
import { HistoryPanel } from "../components/HistoryPanel.js";
import { type FakeHistory, fakeHistory, makeCommit, minutesAfter } from "./panel-fixture.js";

afterEach(cleanup);

let model: ModelApi | null = null;

async function loadModel(): Promise<ModelApi> {
  if (model === null) model = await loadTestModel();
  return model;
}

function loadedModel(): ModelApi {
  if (model === null) throw new Error("loadModel must run first");
  return model;
}

function demoProject(bars = 2): Project {
  return buildDemoProject(
    {
      ...SHORT_DEMO,
      sections: SHORT_DEMO.sections.map((section, index) =>
        index === 0 ? { ...section, bars } : section,
      ),
    },
    {
      assetFor: (key) => fakeAssetHash(`panel:${key}`),
      projectId: "PANEL00000000000000000001",
    },
  ).project;
}

interface Fixture {
  readonly history: FakeHistory;
  readonly liveDoc: Project;
  readonly docs: ReadonlyMap<string, Project>;
}

function fixture(options: { readonly withAnalysis?: boolean } = {}): Fixture {
  const liveDoc = demoProject();
  const commits = [
    makeCommit({
      id: "cmt_root",
      parent: null,
      label: "Imported",
      createdAt: minutesAfter(0),
      authorKind: "system",
    }),
  ];
  if (options.withAnalysis === true) {
    commits.push(
      makeCommit({
        id: "cmt_a1",
        parent: "cmt_root",
        label: "Analysis: rhythm",
        createdAt: minutesAfter(1),
        analysis: true,
      }),
      makeCommit({
        id: "cmt_a2",
        parent: "cmt_a1",
        label: "Analysis: structure",
        createdAt: minutesAfter(2),
        analysis: true,
      }),
      makeCommit({
        id: "cmt_head",
        parent: "cmt_a2",
        label: "Mute Bass",
        createdAt: minutesAfter(3),
      }),
    );
  } else {
    commits.push(
      makeCommit({
        id: "cmt_v1",
        parent: "cmt_root",
        label: "Mute Bass",
        createdAt: minutesAfter(1),
      }),
      makeCommit({
        id: "cmt_v2",
        parent: "cmt_v1",
        label: "Quiet pads",
        createdAt: minutesAfter(2),
      }),
    );
  }
  const head = options.withAnalysis === true ? "cmt_head" : "cmt_v2";
  const docs = new Map(commits.map((commit) => [commit.id, liveDoc]));
  const history = fakeHistory({ commits, head, liveDoc, docs });
  return { history, liveDoc, docs };
}

function panel(
  fixtureValue: Fixture,
  selection: Selection = { kind: "none" },
): ReturnType<typeof render> {
  return render(
    <HistoryPanel
      history={fixtureValue.history.history}
      selection={selection}
      model={loadedModel()}
      liveDoc={fixtureValue.liveDoc}
      onClose={() => {}}
    />,
  );
}

async function openMenu(label: string) {
  await userEvent.click(
    screen.getByRole("button", { name: t("history.panel.actions", { label }) }),
  );
  return screen.findByRole("menu");
}

describe("the history panel", () => {
  it("renders the tree with the current version marked", async () => {
    await loadModel();
    const value = fixture();
    panel(value);

    expect(screen.getByRole("tree", { name: "Version history" })).toBeTruthy();
    expect(screen.getByText("Mute Bass")).toBeTruthy();
    expect(screen.getByText("Quiet pads")).toBeTruthy();
    const head = screen.getByTestId("history-row-cmt_v2");
    expect(head.getAttribute("aria-current")).toBe("true");
    expect(head.getAttribute("aria-selected")).toBe("true");
    expect(head.getAttribute("aria-level")).toBe("1");
    expect(screen.getByTestId("history-row-cmt_v1").getAttribute("aria-current")).toBeNull();
  });

  it("goes back to a version with Enter and moves HEAD", async () => {
    await loadModel();
    const value = fixture();
    panel(value);
    const row = screen.getByTestId("history-row-cmt_v1");
    row.focus();

    fireEvent.keyDown(row, { key: "Enter" });

    await waitFor(() => expect(value.history.calls.checkout).toEqual(["cmt_v1"]));
    await waitFor(() => expect(value.history.store.getState().head).toBe("cmt_v1"));
  });

  it("moves focus with ArrowDown and ArrowUp", async () => {
    await loadModel();
    const value = fixture();
    panel(value);
    screen.getByTestId("history-row-cmt_v2").focus();

    fireEvent.keyDown(screen.getByTestId("history-row-cmt_v2"), { key: "ArrowDown" });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("history-row-cmt_v1")),
    );

    fireEvent.keyDown(screen.getByTestId("history-row-cmt_v1"), { key: "ArrowUp" });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("history-row-cmt_v2")),
    );
  });

  it("chooses two versions for the future A/B compare with Space", async () => {
    await loadModel();
    const value = fixture();
    panel(value);

    const first = screen.getByTestId("history-row-cmt_v1");
    const second = screen.getByTestId("history-row-cmt_root");
    first.focus();
    fireEvent.keyDown(first, { key: " " });
    fireEvent.keyDown(second, { key: " " });

    await waitFor(() => expect(first.getAttribute("aria-selected")).toBe("true"));
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("2 versions chosen to compare")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compare (A/B)" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("collapses an analysis run and expands it with ArrowRight", async () => {
    await loadModel();
    const value = fixture({ withAnalysis: true });
    panel(value);

    const summary = screen.getByTestId("history-analysis-cmt_a2");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("history-row-cmt_a1")).toBeNull();
    expect(summary.textContent).toContain("Analysis");
    expect(summary.textContent).toContain("2 automatic steps");

    summary.focus();
    fireEvent.keyDown(summary, { key: "ArrowRight" });

    await waitFor(() =>
      expect(screen.getByTestId("history-analysis-cmt_a2").getAttribute("aria-expanded")).toBe(
        "true",
      ),
    );
    expect(screen.getByTestId("history-row-cmt_a1")).toBeTruthy();
    expect(screen.getByTestId("history-row-cmt_a2")).toBeTruthy();
  });

  it("stars and unstars a version", async () => {
    await loadModel();
    const value = fixture();
    panel(value);

    await userEvent.click(screen.getByRole("button", { name: "Star Mute Bass" }));
    await waitFor(() => expect(value.history.store.getState().starred.has("cmt_v1")).toBe(true));
    expect(value.history.calls.star).toEqual(["cmt_v1"]);
    const unstar = screen.getByRole("button", { name: "Remove star from Mute Bass" });
    expect(unstar.getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(unstar);
    await waitFor(() => expect(value.history.store.getState().starred.has("cmt_v1")).toBe(false));
  });

  it("names a branch and shows the new chip", async () => {
    await loadModel();
    const value = fixture();
    panel(value);

    const menu = await openMenu("Mute Bass");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Name this branch" }));

    const dialog = await screen.findByRole("dialog", { name: "Name this branch" });
    await userEvent.type(within(dialog).getByLabelText("Branch name"), "Club version");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save name" }));

    await waitFor(() =>
      expect(value.history.store.getState().branches.get("Club version")).toBe("cmt_v1"),
    );
    expect(await screen.findByText("Club version")).toBeTruthy();
  });

  it("disables taking a part without a region selection", async () => {
    await loadModel();
    const value = fixture();
    panel(value);

    const menu = await openMenu("Mute Bass");
    const item = within(menu).getByRole("menuitem", { name: "Take this part from here" });
    expect(
      item.getAttribute("aria-disabled") ?? (item.hasAttribute("data-disabled") ? "true" : null),
    ).toBe("true");
  });

  it("takes a part from an aligned version", async () => {
    await loadModel();
    const value = fixture();
    const selection: Selection = {
      kind: "region",
      region: { startTick: 0, endTick: 2 * 3840, tracks: "all" },
    };
    panel(value, selection);

    const menu = await openMenu("Mute Bass");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Take this part from here" }));

    await waitFor(() => expect(value.history.calls.adopt).toHaveLength(1));
    expect(value.history.calls.adopt[0]?.fromCommit).toBe("cmt_v1");
    expect(value.history.calls.adopt[0]?.region).toEqual(selection.region);
  });

  it("warns and asks again when the section boundaries differ", async () => {
    await loadModel();
    const value = fixture();
    const different = demoProject(3);
    const docs = new Map(value.docs);
    docs.set("cmt_v1", different);
    const history = fakeHistory({
      commits: [...value.history.store.getState().commits.values()],
      head: value.history.store.getState().head,
      liveDoc: value.liveDoc,
      docs,
    });
    const warningFixture: Fixture = { ...value, history, docs };
    panel(warningFixture, {
      kind: "region",
      region: { startTick: 0, endTick: 2 * 3840, tracks: "all" },
    });

    const menu = await openMenu("Mute Bass");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Take this part from here" }));

    const dialog = await screen.findByRole("dialog", { name: "The parts do not line up" });
    expect(within(dialog).getByText(/may sound different/u)).toBeTruthy();
    expect(history.calls.adopt).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole("button", { name: "Take this part anyway" }));
    await waitFor(() => expect(history.calls.adopt).toHaveLength(1));
    expect(history.calls.adopt[0]?.fromCommit).toBe("cmt_v1");
  });
});
