/**
 * The artist-name pre-pass and post-check (10 §7, 10 §8 check 3).
 *
 * A deterministic list in `data/artists.json` (plus the names the request supplies from the
 * user's library) is matched case-insensitively as whole words, including "in the style of X" and
 * "like X". Each match is replaced with plain sonic descriptors before the model sees the prompt,
 * and the plan carries a notice for the user. The post-check rejects a generation prompt that
 * still contains a listed name.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** One curated artist/style entry. */
export interface ArtistEntry {
  name: string;
  descriptors: string[];
}

/** The result of the pre-pass. */
export interface PolicyResult {
  /** The prompt with every listed name replaced by descriptors. */
  prompt: string;
  /** Plain-language notices for the plan, one per name. */
  notices: string[];
  /** The names that were found (curated or from the library). */
  names: string[];
}

/** Plain descriptors for a library name the curated list does not know. */
const GENERIC_DESCRIPTORS = [
  "a similar production style",
  "comparable instrumentation",
  "the same era and energy",
];

/** The curated list, read once from `data/artists.json`. */
let cachedArtists: ArtistEntry[] | undefined;

/** Every curated artist/style entry. */
export function curatedArtists(): ArtistEntry[] {
  cachedArtists ??= loadArtists();
  return cachedArtists;
}

/**
 * Rewrites every listed name in `prompt` as sonic descriptors.
 *
 * @param prompt the user's words
 * @param libraryNames artist/title strings from the user's library
 * @returns the rewritten prompt, the notices and the names that were found
 */
export function applyPolicy(prompt: string, libraryNames: readonly string[] = []): PolicyResult {
  const entries = policyEntries(libraryNames);
  let rewritten = prompt;
  const notices: string[] = [];
  const names: string[] = [];

  for (const entry of entries) {
    const descriptors = entry.descriptors.join(", ");
    const next = rewritten.replace(wholeWordPattern(entry.name), descriptors);
    if (next === rewritten) continue;
    rewritten = next;
    names.push(entry.name);
    notices.push(`I described ${entry.name} as ${descriptors}.`);
  }

  return { prompt: rewritten, notices, names };
}

/**
 * Every listed name still present in `text`. The validator uses this on `generate` step prompts
 * (10 §7: a direct generation prompt that names an artist is rejected with `PROMPT_POLICY`).
 */
export function blockedNamesIn(text: string, extraNames: readonly string[] = []): string[] {
  return policyEntries(extraNames)
    .filter((entry) => wholeWordPattern(entry.name).test(text))
    .map((entry) => entry.name);
}

/** The curated list plus library names the curated list does not already cover, longest first. */
function policyEntries(libraryNames: readonly string[]): ArtistEntry[] {
  const byName = new Map<string, ArtistEntry>();
  for (const entry of curatedArtists()) byName.set(entry.name.toLowerCase(), entry);
  for (const name of libraryNames) {
    const trimmed = name.trim();
    if (trimmed === "") continue;
    const key = trimmed.toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, { name: trimmed, descriptors: GENERIC_DESCRIPTORS });
    }
  }
  return [...byName.values()].sort((a, b) => b.name.length - a.name.length);
}

/** A case-insensitive whole-word matcher for one name. */
function wholeWordPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "gi");
}

/** Reads the curated list from `data/`, falling back to the source tree under `dist/`. */
function loadArtists(): ArtistEntry[] {
  const candidates = [
    new URL("./data/artists.json", import.meta.url),
    new URL("../../src/planner/data/artists.json", import.meta.url),
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    if (!existsSync(path)) continue;
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(data) || !Array.isArray(data.artists)) {
      throw new Error(`${path}: expected an { artists: [...] } object`);
    }
    return data.artists.map((entry): ArtistEntry => {
      if (
        !isRecord(entry) ||
        typeof entry.name !== "string" ||
        !Array.isArray(entry.descriptors) ||
        entry.descriptors.length < 3 ||
        !entry.descriptors.every((descriptor) => typeof descriptor === "string")
      ) {
        throw new Error(`${path}: every artist needs a name and 3–5 descriptors`);
      }
      return { name: entry.name, descriptors: entry.descriptors };
    });
  }
  throw new Error("planner artist list data/artists.json is missing from the package");
}

/** A plain object, not an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
