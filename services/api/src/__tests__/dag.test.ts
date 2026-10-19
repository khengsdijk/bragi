import { describe, expect, it } from "vitest";

import {
  ANALYSIS_DAG,
  allStages,
  IMPLEMENTED_STAGES,
  implementedStagesForProfile,
  nodeMap,
  readyStages,
  type StageNode,
  stagesForProfile,
  topologicalOrder,
} from "../jobs/dag.js";

describe("the 04 §2 analysis DAG", () => {
  it("has no cycles", () => {
    expect(() => topologicalOrder(new Set(ANALYSIS_DAG.map((node) => node.stage)))).not.toThrow();
  });

  it("puts every stage after its dependencies", () => {
    const order = allStages();
    const position = new Map(order.map((stage, index) => [stage, index]));
    for (const node of ANALYSIS_DAG) {
      for (const dep of node.dependsOn) {
        const depPosition = position.get(dep);
        const stagePosition = position.get(node.stage);
        expect(depPosition).toBeDefined();
        expect(stagePosition).toBeDefined();
        expect(depPosition ?? Number.MAX_SAFE_INTEGER).toBeLessThan(
          stagePosition ?? Number.MIN_SAFE_INTEGER,
        );
      }
    }
  });

  it("closes every profile over its dependencies", () => {
    for (const stage of stagesForProfile("standard")) {
      const node = ANALYSIS_DAG.find((candidate) => candidate.stage === stage);
      for (const dep of node?.dependsOn ?? []) {
        expect(stagesForProfile("standard")).toContain(dep);
      }
    }
  });

  it("grows the profile sets monotonically: quick ⊆ standard ⊆ deep", () => {
    const quick = new Set(stagesForProfile("quick"));
    const standard = new Set(stagesForProfile("standard"));
    const deep = new Set(stagesForProfile("deep"));
    for (const stage of quick) expect(standard.has(stage)).toBe(true);
    for (const stage of standard) expect(deep.has(stage)).toBe(true);
  });
});

describe("readyStages", () => {
  it("releases only the stages whose dependencies are complete", () => {
    const pending = stagesForProfile("standard");
    expect(readyStages(new Set(), pending)).toEqual(["ingest"]);
    expect(new Set(readyStages(new Set(["ingest"]), pending))).toEqual(
      new Set(["rhythm", "loudness_energy", "preview", "embed_full", "separation"]),
    );
  });

  it("never releases a stage whose dependency is still pending", () => {
    const pending = ["ingest", "rhythm", "structure"];
    expect(readyStages(new Set(["ingest"]), pending)).toEqual(["rhythm"]);
    expect(readyStages(new Set(["ingest", "rhythm"]), pending)).toEqual(["structure"]);
  });

  it("treats a dependency outside this run as satisfied", () => {
    // `describe` depends on `harmony`, which this subset does not include.
    expect(readyStages(new Set<string>(), ["describe"])).toEqual(["describe"]);
  });

  it("returns nothing once everything is complete", () => {
    const pending = stagesForProfile("quick");
    expect(readyStages(new Set(pending), pending)).toEqual([]);
  });
});

describe("IMPLEMENTED_STAGES", () => {
  it("is a subset of the DAG", () => {
    for (const stage of IMPLEMENTED_STAGES) {
      expect(ANALYSIS_DAG.some((node) => node.stage === stage)).toBe(true);
    }
  });

  it("never drops a dependency of an implemented stage", () => {
    for (const profile of ["quick", "standard", "deep"] as const) {
      const requested = new Set(stagesForProfile(profile));
      const kept = new Set(implementedStagesForProfile(profile));
      for (const stage of kept) {
        const node = ANALYSIS_DAG.find((candidate) => candidate.stage === stage);
        for (const dep of node?.dependsOn ?? []) {
          if (requested.has(dep)) expect(kept.has(dep)).toBe(true);
        }
      }
    }
  });

  it("keeps a standard analysis runnable start to finish", () => {
    const stages = implementedStagesForProfile("standard");
    expect(stages[0]).toBe("ingest");
    // Every stage without a worker is gone; the terminal ones have no dependents.
    for (const missing of ["preview", "energy_stems", "drum_split", "transcribe", "lyrics"]) {
      expect(stages).not.toContain(missing);
    }
    expect(stages).toContain("separation");
    expect(stages).toContain("stem_embed");
    expect(stages).toContain("tag");
    expect(stages).toContain("describe");
  });
});

describe("topologicalOrder", () => {
  it("detects a cycle", () => {
    const nodes: StageNode[] = [
      { stage: "a", dependsOn: ["b"] },
      { stage: "b", dependsOn: ["a"] },
    ];
    expect(() => topologicalOrder(new Set(["a", "b"]), nodeMap(nodes))).toThrow(/cycle/);
  });

  it("ignores edges to stages outside the selection", () => {
    const nodes: StageNode[] = [
      { stage: "a", dependsOn: [] },
      { stage: "b", dependsOn: ["a", "outside"] },
    ];
    expect(topologicalOrder(new Set(["b"]), nodeMap(nodes))).toEqual(["b"]);
  });
});
