import { describe, expect, it } from "vitest";

import {
  BUNDLE_ID,
  bundleSchemas,
  listSchemaFiles,
  readSchemaFiles,
  SchemaConventionError,
} from "../../codegen/bundle.mjs";

/** The schema root (`packages/schemas`). */
const SCHEMAS = new URL("../../", import.meta.url).pathname;

/** One source schema file, as `readSchemaFiles` returns it. */
type SchemaFile = { path: string; schema: Record<string, unknown> };

/** A file whose root is a type. */
function root(path: string, title: string, body: Record<string, unknown> = {}): SchemaFile {
  return {
    path,
    schema: { $schema: "https://json-schema.org/draft/2020-12/schema", title, ...body },
  };
}

/** A file that only holds `$defs`. */
function defs(path: string, $defs: Record<string, unknown>): SchemaFile {
  return { path, schema: { $schema: "https://json-schema.org/draft/2020-12/schema", $defs } };
}

/** The bundle's `$defs`, typed for assertions. */
function defsOf(bundle: { $defs?: unknown }): Record<string, unknown> {
  return bundle.$defs as Record<string, unknown>;
}

/** Bundles `files` and returns the problems the bundler raised. */
function problems(files: SchemaFile[]): string[] {
  try {
    bundleSchemas(files);
    return [];
  } catch (error) {
    if (error instanceof SchemaConventionError) return error.problems;
    throw error;
  }
}

describe("bundleSchemas", () => {
  it("gives every file root and $def a name, and lists the roots", () => {
    const { bundle, rootTypes } = bundleSchemas([
      defs("common.schema.json", { Name: { type: "string" } }),
      root("thing.schema.json", "Thing", {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: { name: { $ref: "common.schema.json#/$defs/Name" } },
      }),
    ]);
    expect(bundle.$id).toBe(BUNDLE_ID);
    expect(bundle.$defs).toEqual({
      Name: { title: "Name", type: "string" },
      Thing: {
        title: "Thing",
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: { name: { $ref: "#/$defs/Name" } },
      },
    });
    expect(rootTypes).toEqual(["Thing"]);
  });

  it("lifts an inline single-value enum into a named def", () => {
    const { bundle } = bundleSchemas([
      root("thing.schema.json", "Thing", {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: { kind: { type: "string", enum: ["thing"] } },
      }),
    ]);
    const defs = defsOf(bundle);
    expect(defs.Thing).toMatchObject({
      properties: { kind: { $ref: "#/$defs/ThingKind" } },
    });
    expect(defs.ThingKind).toEqual({ title: "ThingKind", type: "string", enum: ["thing"] });
  });

  it("keeps a description next to a $ref", () => {
    const { bundle } = bundleSchemas([
      defs("common.schema.json", { Name: { type: "string" } }),
      root("thing.schema.json", "Thing", {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: { name: { $ref: "common.schema.json#/$defs/Name", description: "docs" } },
      }),
    ]);
    expect(defsOf(bundle).Thing).toMatchObject({
      properties: { name: { $ref: "#/$defs/Name", description: "docs" } },
    });
  });

  it.each([
    [
      "a duplicate type name",
      [
        defs("a.schema.json", { Name: { type: "string" } }),
        defs("b.schema.json", { Name: { type: "string" } }),
      ],
      /already defined/,
    ],
    [
      "a root without a PascalCase title",
      [{ path: "a.schema.json", schema: { type: "object", additionalProperties: false } }],
      /PascalCase "title"/,
    ],
    [
      "an inline object",
      [
        root("a.schema.json", "A", {
          type: "object",
          additionalProperties: false,
          properties: {
            nested: {
              type: "object",
              additionalProperties: false,
              properties: { a: { type: "string" } },
            },
          },
        }),
      ],
      /inline object type/,
    ],
    [
      "an object without additionalProperties: false",
      [root("a.schema.json", "A", { type: "object", properties: { a: { type: "string" } } })],
      /additionalProperties/,
    ],
    [
      "a bare object with no additionalProperties at all",
      [root("a.schema.json", "A", { type: "object" })],
      /must declare "additionalProperties"/,
    ],
    [
      "const instead of enum",
      [root("a.schema.json", "A", { type: "string", const: "x" })],
      /instead of "const"/,
    ],
    [
      "format",
      [root("a.schema.json", "A", { type: "string", format: "date-time" })],
      /no "format"/,
    ],
    [
      "an inline multi-value enum",
      [
        root("a.schema.json", "A", {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: { kind: { type: "string", enum: ["a", "b"] } },
        }),
      ],
      /inline multi-value enum/,
    ],
    [
      "an \\d pattern",
      [root("a.schema.json", "A", { type: "string", pattern: "^\\d+$" })],
      /\[0-9\] instead of/,
    ],
    [
      "look-around in a pattern",
      [root("a.schema.json", "A", { type: "string", pattern: "(?=x)" })],
      /no look-around/,
    ],
    [
      "a $ref sibling other than description",
      [
        defs("common.schema.json", { Name: { type: "string" } }),
        root("a.schema.json", "A", {
          type: "object",
          additionalProperties: false,
          required: ["n"],
          properties: { n: { $ref: "common.schema.json#/$defs/Name", minLength: 1 } },
        }),
      ],
      /may only sit next to "description"/,
    ],
    [
      "a non-PascalCase $def",
      [defs("a.schema.json", { name: { type: "string" } })],
      /is not PascalCase/,
    ],
    [
      "an unreachable $def",
      [defs("a.schema.json", { Orphan: { type: "string" } })],
      /unreachable from any file root/,
    ],
    [
      "an optional inline array",
      [
        root("a.schema.json", "A", {
          type: "object",
          additionalProperties: false,
          properties: { list: { type: "array", items: { type: "string" } } },
        }),
      ],
      /optional array must be a named \$def/,
    ],
    [
      "an unresolvable $ref",
      [
        root("a.schema.json", "A", {
          type: "object",
          additionalProperties: false,
          required: ["x"],
          properties: { x: { $ref: "missing.schema.json" } },
        }),
      ],
      /unresolvable \$ref/,
    ],
    [
      "anyOf",
      [
        defs("common.schema.json", { A: { type: "string" }, B: { type: "string" } }),
        root("a.schema.json", "A", { anyOf: [{ $ref: "common.schema.json#/$defs/A" }] }),
      ],
      /use "oneOf"/,
    ],
  ])("rejects %s", (_label, files, pattern) => {
    const found = problems(files as SchemaFile[]).join("\n");
    expect(found).toMatch(pattern as RegExp);
  });

  it("rejects a union branch that is not a $ref", () => {
    expect(
      problems([root("a.schema.json", "A", { oneOf: [{ type: "string" }] })]).join("\n"),
    ).toMatch(/union branches must be \$refs/);
  });

  it("collects every problem instead of failing on the first", () => {
    expect(
      problems([
        root("a.schema.json", "A", {
          type: "object",
          additionalProperties: false,
          properties: { b: { const: 1 }, c: { format: "uri" } },
        }),
      ]),
    ).toHaveLength(2);
  });

  it("walks the real schema tree, sorted, and pins every ref", () => {
    const files = listSchemaFiles(SCHEMAS);
    expect(files).toContain("song/project.schema.json");
    expect(files).toEqual([...files].sort());
    const { bundle, rootTypes } = bundleSchemas(readSchemaFiles(SCHEMAS));
    expect(rootTypes).toContain("Project");
    const referenced = [...JSON.stringify(bundle).matchAll(/"\$ref":"#\/\$defs\/([A-Za-z0-9]+)"/g)]
      .map((match) => match[1])
      .filter((name) => name !== undefined);
    for (const name of referenced) expect(defsOf(bundle)).toHaveProperty(name);
  });
});
