import { describe, expect, it } from "vitest";

import { arrangementIntent, classify, hasSongWideIntent } from "../classify.js";
import { testRequest } from "./fixtures.js";

describe("arrangementIntent", () => {
  it("recognises section edits as song-wide requests", () => {
    for (const prompt of [
      "remove the second verse",
      "duplicate the final chorus once",
      "move the outro before the final chorus",
      "rename verse 1 to First Light",
      "shorten the intro by half",
      "make the final chorus two bars longer by looping it",
      "join the verse and the chorus",
    ]) {
      expect(arrangementIntent(prompt), prompt).toBe(true);
      expect(hasSongWideIntent(prompt), prompt).toBe(true);
    }
  });

  it("leaves mix and fx prompts alone", () => {
    for (const prompt of [
      "make the drums warmer",
      "mute the texture track",
      "turn the keys down by 3 dB",
      "make the bridge calmer",
      "give the vocals more space",
    ]) {
      expect(arrangementIntent(prompt), prompt).toBe(false);
      expect(hasSongWideIntent(prompt), prompt).toBe(false);
    }
  });

  it("keeps the explicit whole-song phrases working", () => {
    expect(hasSongWideIntent("make the whole song warmer")).toBe(true);
    expect(hasSongWideIntent("brighten every track a little")).toBe(true);
  });
});

describe("classify", () => {
  it("marks an arrangement prompt as song-wide but keeps the tier heuristic", () => {
    const request = testRequest({ prompt: "remove the second verse" });
    expect(classify(request)).toMatchObject({ songWideIntent: true, explainIntent: false });
  });
});
