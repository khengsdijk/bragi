import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { applyPolicy, blockedNamesIn, curatedArtists } from "../policy.js";

interface PromptFixture {
  name: string;
  prompt: string;
}

const FIXTURES = JSON.parse(
  readFileSync(new URL("../../../test/planner-bench/policy-prompts.json", import.meta.url), "utf8"),
) as { withNames: PromptFixture[]; clean: string[] };

describe("curated artist list", () => {
  it("has at least 40 names with 3–5 plain descriptors each", () => {
    const artists = curatedArtists();
    expect(artists.length).toBeGreaterThanOrEqual(40);
    for (const entry of artists) {
      expect(entry.descriptors.length).toBeGreaterThanOrEqual(3);
      expect(entry.descriptors.length).toBeLessThanOrEqual(5);
      for (const descriptor of entry.descriptors) {
        expect(descriptor).not.toContain(entry.name);
      }
    }
  });
});

describe("applyPolicy — 10 §8 check 3", () => {
  it("has 20 fixtures with names and 20 without", () => {
    expect(FIXTURES.withNames).toHaveLength(20);
    expect(FIXTURES.clean).toHaveLength(20);
  });

  it.each(FIXTURES.withNames.map((entry) => [entry.name, entry.prompt] as const))(
    "rewrites %s and records a notice",
    (name, prompt) => {
      const result = applyPolicy(prompt);
      expect(result.prompt.toLowerCase()).not.toContain(name.toLowerCase());
      expect(result.names).toContain(name);
      expect(result.notices).toHaveLength(1);
      expect(result.notices[0]).toContain(name);
      expect(result.notices[0]).toContain("I described");
    },
  );

  it.each(FIXTURES.clean.map((prompt) => [prompt] as const))("leaves %s unchanged", (prompt) => {
    const result = applyPolicy(prompt);
    expect(result.prompt).toBe(prompt);
    expect(result.notices).toEqual([]);
    expect(result.names).toEqual([]);
  });

  it("covers the 'in the style of' and 'like' phrasings", () => {
    expect(applyPolicy("in the style of Daft Punk").prompt).toBe(
      "in the style of filtered disco house, vocoder vocals, French touch compression, talkbox leads",
    );
    expect(applyPolicy("make it like Prince").notices[0]).toContain("Prince");
  });

  it("rewrites a library name the curated list does not know", () => {
    const result = applyPolicy("make it sound like Midnight Drive", ["Midnight Drive"]);
    expect(result.prompt).not.toContain("Midnight Drive");
    expect(result.notices[0]).toContain("a similar production style");
  });

  it("does not rewrite a name inside a longer word", () => {
    expect(applyPolicy("a draker sound").prompt).toBe("a draker sound");
  });

  it("finds a blocked name in a generation prompt", () => {
    expect(blockedNamesIn("a dusty groove like Daft Punk")).toEqual(["Daft Punk"]);
    expect(blockedNamesIn("a dusty groove")).toEqual([]);
    expect(blockedNamesIn("like My Own Song", ["My Own Song"])).toEqual(["My Own Song"]);
  });
});
