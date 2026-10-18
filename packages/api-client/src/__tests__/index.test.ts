import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PACKAGE_NAME } from "../index.js";

describe("@bragi/api-client", () => {
  it("reports the name declared in its package.json", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    expect(manifest).toMatchObject({ name: PACKAGE_NAME });
  });
});
