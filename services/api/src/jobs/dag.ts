/**
 * The analysis DAG and its executor (specs/04-analysis-pipeline.md §2, 05 §4.4).
 *
 * The graph is data, not control flow: `api-orchestrator` keeps the state in
 * Postgres (`analyses`) and asks {@link readyStages} which dependents to enqueue
 * whenever a stage completes. Keeping the executor pure is what makes it
 * testable without NATS or a database.
 */

export type AnalysisProfile = "quick" | "standard" | "deep";

export interface StageNode {
  readonly stage: string;
  readonly dependsOn: readonly string[];
}

/** Edges from the 04 §2 diagram. Order is irrelevant; readiness is not. */
export const ANALYSIS_DAG: readonly StageNode[] = [
  { stage: "ingest", dependsOn: [] },
  { stage: "rhythm", dependsOn: ["ingest"] },
  { stage: "loudness_energy", dependsOn: ["ingest"] },
  { stage: "preview", dependsOn: ["ingest"] },
  { stage: "embed_full", dependsOn: ["ingest"] },
  { stage: "tag", dependsOn: ["embed_full"] },
  { stage: "separation", dependsOn: ["ingest"] },
  { stage: "structure", dependsOn: ["rhythm"] },
  { stage: "harmony", dependsOn: ["separation"] },
  { stage: "stem_activity", dependsOn: ["separation"] },
  { stage: "stem_embed", dependsOn: ["separation"] },
  { stage: "energy_stems", dependsOn: ["separation", "loudness_energy"] },
  { stage: "section_embed", dependsOn: ["structure"] },
  {
    stage: "describe",
    dependsOn: ["structure", "harmony", "tag", "stem_activity", "section_embed", "stem_embed"],
  },
  { stage: "drum_split", dependsOn: ["separation"] },
  { stage: "transcribe", dependsOn: ["separation"] },
  { stage: "lyrics", dependsOn: ["separation"] },
];

/** The stages each profile requests (04 §3). */
export const PROFILE_STAGES: Record<AnalysisProfile, readonly string[]> = {
  quick: ["ingest", "rhythm", "loudness_energy", "preview", "embed_full", "tag"],
  standard: [
    "ingest",
    "rhythm",
    "loudness_energy",
    "preview",
    "embed_full",
    "tag",
    "separation",
    "structure",
    "harmony",
    "stem_activity",
    "energy_stems",
    "section_embed",
    "stem_embed",
    "describe",
  ],
  deep: [
    "ingest",
    "rhythm",
    "loudness_energy",
    "preview",
    "embed_full",
    "tag",
    "separation",
    "structure",
    "harmony",
    "stem_activity",
    "energy_stems",
    "section_embed",
    "stem_embed",
    "describe",
    "drum_split",
    "transcribe",
    "lyrics",
  ],
};

const BY_STAGE = new Map(ANALYSIS_DAG.map((node) => [node.stage, node]));

export function stageNode(stage: string): StageNode | undefined {
  return BY_STAGE.get(stage);
}

/** A lookup by stage name; testable graphs can be passed instead of the DAG. */
export type StageNodes = ReadonlyMap<string, StageNode>;

/** Builds a lookup from a node list. */
export function nodeMap(nodes: readonly StageNode[]): StageNodes {
  return new Map(nodes.map((node) => [node.stage, node]));
}

/**
 * Every stage a profile needs, including ancestors the profile lists implicitly.
 *
 * @param profile requested profile
 * @returns the stages in a valid topological order
 * @throws Error when the profile names a stage that is not in the DAG
 */
export function stagesForProfile(profile: AnalysisProfile): string[] {
  const seeds = PROFILE_STAGES[profile];
  const needed = new Set<string>();
  const visit = (stage: string): void => {
    if (needed.has(stage)) return;
    const node = BY_STAGE.get(stage);
    if (!node) throw new Error(`unknown analysis stage: ${stage}`);
    needed.add(stage);
    for (const dep of node.dependsOn) visit(dep);
  };
  for (const stage of seeds) visit(stage);
  return topologicalOrder(needed);
}

/**
 * The pending stages whose dependencies are all complete.
 *
 * A dependency that is neither complete nor pending is treated as satisfied:
 * it is outside this analysis run, so it cannot hold a stage back.
 *
 * @param completed stages already finished (or cached)
 * @param pending stages still to run
 * @returns the subset of `pending` that may be enqueued now, in DAG order
 */
export function readyStages(
  completed: ReadonlySet<string>,
  pending: readonly string[],
  nodes: StageNodes = BY_STAGE,
): string[] {
  const pendingSet = new Set(pending);
  const ordered = topologicalOrder(pendingSet, nodes);
  return ordered.filter((stage) => {
    if (completed.has(stage)) return false;
    const node = nodes.get(stage);
    if (!node) return false;
    return node.dependsOn.every((dep) => completed.has(dep) || !pendingSet.has(dep));
  });
}

/**
 * Orders a set of stages so every stage comes after its dependencies.
 *
 * @param stages the stages to order
 * @param nodes the graph to order within (defaults to the analysis DAG)
 * @returns the stages in dependency order
 * @throws Error when the selection contains a cycle
 */
export function topologicalOrder(
  stages: ReadonlySet<string>,
  nodes: StageNodes = BY_STAGE,
): string[] {
  const ordered: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (stage: string): void => {
    const current = state.get(stage);
    if (current === "done") return;
    if (current === "visiting") throw new Error(`cycle in the analysis DAG at ${stage}`);
    state.set(stage, "visiting");
    for (const dep of nodes.get(stage)?.dependsOn ?? []) {
      if (stages.has(dep)) visit(dep);
    }
    state.set(stage, "done");
    ordered.push(stage);
  };
  for (const stage of stages) visit(stage);
  return ordered;
}

/** All stages in the DAG, topologically ordered. */
export function allStages(): string[] {
  return topologicalOrder(new Set(BY_STAGE.keys()));
}
