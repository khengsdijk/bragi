import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PACKAGE_NAME } from "../index.js";

describe("@bragi/design", () => {
  it("reports the name declared in its package.json", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"),
    );
    expect(manifest).toMatchObject({ name: PACKAGE_NAME });
  });
});
