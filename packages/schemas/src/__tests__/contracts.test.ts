import { readdirSync, readFileSync } from "node:fs";

import type { ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";

import * as schemas from "../index.js";

/**
 * Every exported validator, by root type name. The module namespace also holds types and
 * constants, so the lookup is by the `validate<RootType>` naming convention from
 * `generated/validators.ts`.
 */
const VALIDATORS = schemas as unknown as Record<string, ValidateFunction | undefined>;

/** `packages/schemas/`, resolved from this test file. */
const PACKAGE = new URL("../../", import.meta.url);
/** The repository root. */
const REPO = new URL("../../../../", import.meta.url);

const EXAMPLES = `${PACKAGE.pathname}examples/`;

/** Reads and parses a JSON file. */
function readJson(path: string | URL): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The root type names that have an example file, sorted. */
function exampleNames(): string[] {
  return readdirSync(EXAMPLES)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.replace(/\.json$/, ""))
    .sort();
}

/**
 * Parses `text` through the validator for `T`, so the returned value is typed by the same
 * contract the validator enforces. Throws with the validation errors when it does not conform.
 */
function parseAs<T>(validate: ValidateFunction<T>, text: string): T {
  const value: unknown = JSON.parse(text);
  if (!validate(value)) {
    throw new Error(`document does not validate:\n${JSON.stringify(validate.errors, null, 2)}`);
  }
  return value;
}

describe("root types", () => {
  it("generates a validator for every example, and an example for every root type", () => {
    expect([...schemas.ROOT_TYPES]).toEqual(exampleNames());
    for (const name of schemas.ROOT_TYPES) {
      expect(typeof VALIDATORS[`validate${name}`], name).toBe("function");
    }
  });

  it("has no validator for a type that has no example", () => {
    expect(Object.keys(VALIDATORS).filter((key) => key.startsWith("validate"))).toHaveLength(
      schemas.ROOT_TYPES.length,
    );
  });
});

describe("acceptance: the 02 §10 example document", () => {
  it("is the JSON block in specs/02-song-model.md §10", () => {
    const spec = readFileSync(new URL("specs/02-song-model.md", REPO), "utf8");
    const section = spec.slice(spec.indexOf("## 10. Example document"));
    const block = /```json\n([\s\S]*?)```/.exec(section);
    if (block?.[1] === undefined) throw new Error("no JSON block in 02 §10");
    expect(readJson(new URL("fixtures/projects/example-02-10.json", REPO))).toEqual(
      JSON.parse(block[1]),
    );
  });

  it("validates, and round-trips losslessly through the typed value", () => {
    const text = readFileSync(new URL("fixtures/projects/example-02-10.json", REPO), "utf8");
    const validate = VALIDATORS.validateProject;
    if (validate === undefined) throw new Error("no validateProject");
    const typed = parseAs(validate, text);
    expect(typed).toEqual(JSON.parse(text));
    const once = JSON.stringify(typed);
    expect(JSON.stringify(JSON.parse(once))).toBe(once);
  });
});

describe("acceptance: every example validates and round-trips losslessly", () => {
  it.each(exampleNames())("%s", (name) => {
    const validate = VALIDATORS[`validate${name}`];
    if (validate === undefined) throw new Error(`no validator for ${name}`);
    const text = readFileSync(`${EXAMPLES}${name}.json`, "utf8");
    const typed = parseAs(validate, text);

    // `toEqual` compares structurally (key order ignored) and `0`/`0.0` are the same JS number, so
    // this is the "equal as JSON values, numbers numerically, bool != number" comparison.
    expect(typed).toEqual(JSON.parse(text));

    // Serialising the typed value twice is byte-identical, so no field is re-ordered or dropped
    // between writes.
    const once = JSON.stringify(typed);
    expect(JSON.stringify(JSON.parse(once))).toBe(once);
  });
});

describe("invalid documents", () => {
  const cases = (
    readJson(new URL("fixtures/projects/invalid-cases.json", REPO)) as {
      cases: { name: string; type: string; why: string; checkedBy: string[]; document: unknown }[];
    }
  ).cases;

  it("has at least one case per rejection kind", () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    const validate = VALIDATORS[`validate${entry.type}`];
    if (validate === undefined) throw new Error(`no validator for ${entry.type}`);
    const valid = validate(entry.document);
    if (entry.checkedBy.includes("typescript")) {
      expect(valid, entry.why).toBe(false);
      expect(validate.errors?.length ?? 0).toBeGreaterThan(0);
    } else {
      expect(valid, entry.why).toBe(true);
    }
  });
});

describe("the API error-code registry", () => {
  const registry = readJson(new URL("api/errors.json", PACKAGE)) as {
    codes: { code: string }[];
  };
  const bundle = readJson(new URL("generated/bundle.schema.json", PACKAGE)) as {
    $defs: Record<string, { enum?: string[] }>;
  };

  it("equals the generated ErrorCode enum", () => {
    expect(registry.codes.map((entry) => entry.code).sort()).toEqual(
      [...(bundle.$defs.ErrorCode?.enum ?? [])].sort(),
    );
  });

  it("is a union of string literals in the generated TypeScript types", () => {
    const known: schemas.ErrorCode = "QUOTA_EXCEEDED";
    // @ts-expect-error — a code that is not in the registry must not typecheck.
    const unknown: schemas.ErrorCode = "NOT_A_CODE";
    expect([known, unknown].length).toBe(2);
  });

  it("validates the error envelope and rejects an unknown code", () => {
    const validate = VALIDATORS.validateApiError;
    if (validate === undefined) throw new Error("no validateApiError");
    expect(validate({ error: { code: "QUOTA_EXCEEDED", message: "Out of credits." } })).toBe(true);
    expect(validate({ error: { code: "NOT_A_CODE", message: "?" } })).toBe(false);
  });
});
