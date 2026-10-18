/**
 * Bundles every `*.schema.json` in packages/schemas into one JSON Schema 2020-12 document whose
 * `$defs` hold every named type, with every `$ref` rewritten to `#/$defs/<Name>`.
 *
 * The three code generators (json-schema-to-typescript, typify, datamodel-code-generator) and Ajv
 * all read this one bundle, so a type has the same name in TypeScript, Rust and Python.
 *
 * It also enforces the authoring conventions that keep the generated types lossless and
 * consistently named (docs/wp/0.2.md, packages/schemas/README.md). A violation throws
 * {@link SchemaConventionError} listing every problem found.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";

/** Directories under packages/schemas that hold source schemas. */
export const SCHEMA_DIRS = ["song", "analysis", "jobs", "api"];

export const BUNDLE_ID = "https://bragi.app/schemas/bundle.schema.json";

/** Keywords a `$ref` may sit next to. Anything else would be silently ignored by some generator. */
const REF_SIBLINGS = new Set(["$ref", "description"]);

/** Keywords that hold one subschema. */
const SUBSCHEMA_KEYS = ["items", "additionalProperties", "propertyNames", "not", "contains"];
/** Keywords that hold an array of subschemas. */
const SUBSCHEMA_ARRAY_KEYS = ["oneOf", "anyOf", "allOf", "prefixItems"];

export class SchemaConventionError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`Schema convention violations:\n  - ${problems.join("\n  - ")}`);
    this.name = "SchemaConventionError";
    /** @type {string[]} */
    this.problems = problems;
  }
}

/**
 * @typedef {{ [key: string]: unknown }} JsonObject
 * @typedef {{ path: string, schema: JsonObject }} SchemaFile path is posix, relative to the schema root
 */

/**
 * Lists the source schema files under `root` (packages/schemas), sorted.
 *
 * @param {string} root
 * @returns {string[]} posix paths relative to `root`
 */
export function listSchemaFiles(root) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".schema.json")) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  for (const dir of SCHEMA_DIRS) walk(join(root, dir));
  return out.sort();
}

/**
 * Reads the source schemas under `root`.
 *
 * @param {string} root
 * @returns {SchemaFile[]}
 */
export function readSchemaFiles(root) {
  return listSchemaFiles(root).map((path) => ({
    path,
    schema: /** @type {JsonObject} */ (JSON.parse(readFileSync(join(root, path), "utf8"))),
  }));
}

/**
 * @param {unknown} value
 * @returns {value is JsonObject}
 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A file's root is a type when it describes a value; otherwise the file is only a container of
 * `$defs` (like song/common.schema.json).
 *
 * @param {JsonObject} schema
 */
function rootIsType(schema) {
  return "type" in schema || "oneOf" in schema || "anyOf" in schema;
}

/**
 * Bundles the given schema files.
 *
 * @param {SchemaFile[]} files
 * @returns {{ bundle: JsonObject, rootTypes: string[] }} the bundle, and the name of each file's
 *   root type (file roots that are types, sorted)
 * @throws {SchemaConventionError}
 */
export function bundleSchemas(files) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, string>} "<path>#<pointer>" → bundle name */
  const names = new Map();
  /** @type {Map<string, string>} bundle name → where it was defined */
  const origin = new Map();

  /** @param {string} name @param {string} where */
  const claim = (name, where) => {
    const previous = origin.get(name);
    if (previous) problems.push(`${where}: type name "${name}" is already defined in ${previous}`);
    else origin.set(name, where);
  };

  for (const { path, schema } of files) {
    if (rootIsType(schema)) {
      const title = schema.title;
      if (typeof title !== "string" || !/^[A-Z][A-Za-z0-9]*$/.test(title)) {
        problems.push(`${path}: a root type needs a PascalCase "title" (its type name)`);
      } else {
        names.set(`${path}#`, title);
        claim(title, path);
      }
    }
    const defs = schema.$defs;
    if (defs !== undefined && !isObject(defs)) problems.push(`${path}: "$defs" must be an object`);
    for (const key of Object.keys(isObject(defs) ? defs : {})) {
      if (!/^[A-Z][A-Za-z0-9]*$/.test(key)) problems.push(`${path}: $defs/${key} is not PascalCase`);
      names.set(`${path}#/$defs/${key}`, key);
      claim(key, `${path}#/$defs/${key}`);
    }
  }

  /** @type {JsonObject} */
  const defs = {};

  for (const { path, schema } of files) {
    /**
     * @param {string} ref
     * @param {string} where
     */
    const resolveRef = (ref, where) => {
      const [refPath = "", pointer = ""] = ref.split("#");
      const target = refPath === "" ? path : posix.normalize(posix.join(dirname(path), refPath));
      const name = names.get(`${target}#${pointer}`);
      if (!name) {
        problems.push(`${where}: unresolvable $ref "${ref}"`);
        return ref;
      }
      return `#/$defs/${name}`;
    };

    /**
     * Copies a schema node with refs rewritten, checking the conventions.
     *
     * @param {unknown} node
     * @param {string} where JSON-pointer-ish location for messages
     * @param {boolean} named whether this node is a named type (a file root or a $def)
     * @returns {unknown}
     */
    const rewrite = (node, where, named) => {
      if (!isObject(node)) return node;
      checkNode(node, where, named, problems);
      /** @type {JsonObject} */
      const out = {};
      for (const [key, value] of Object.entries(node)) {
        if (key === "$schema" || key === "$defs") continue;
        if (key === "$ref" && typeof value === "string") {
          out.$ref = resolveRef(value, where);
        } else if (key === "properties" && isObject(value)) {
          const required = Array.isArray(node.required) ? node.required : [];
          out.properties = Object.fromEntries(
            Object.entries(value).map(([prop, sub]) => {
              const at = `${where}/properties/${prop}`;
              if (!required.includes(prop)) checkOptional(sub, at, problems);
              return [prop, rewrite(sub, at, false)];
            }),
          );
        } else if (SUBSCHEMA_KEYS.includes(key)) {
          out[key] = rewrite(value, `${where}/${key}`, false);
        } else if (SUBSCHEMA_ARRAY_KEYS.includes(key) && Array.isArray(value)) {
          out[key] = value.map((sub, i) => rewrite(sub, `${where}/${key}/${i}`, false));
        } else {
          out[key] = value;
        }
      }
      return out;
    };

    if (rootIsType(schema) && typeof schema.title === "string") {
      defs[schema.title] = rewrite(schema, path, true);
    }
    const fileDefs = isObject(schema.$defs) ? schema.$defs : {};
    for (const [key, sub] of Object.entries(fileDefs)) {
      const def = rewrite(sub, `${path}#/$defs/${key}`, true);
      defs[key] = isObject(def) ? { title: key, ...def } : def;
    }
  }

  if (problems.length > 0) throw new SchemaConventionError(problems);

  const sorted = Object.fromEntries(Object.keys(defs).sort().map((k) => [k, defs[k]]));
  return {
    bundle: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: BUNDLE_ID,
      $comment:
        "GENERATED by `pnpm schemas:gen` from packages/schemas/{song,analysis,jobs,api}/**/*.schema.json. Do not edit.",
      title: "BragiSchemas",
      $defs: sorted,
    },
    rootTypes: files
      .filter(({ schema }) => rootIsType(schema) && typeof schema.title === "string")
      .map(({ schema }) => /** @type {string} */ (schema.title))
      .sort(),
  };
}

/**
 * Per-node convention checks (see packages/schemas/README.md).
 *
 * @param {JsonObject} node
 * @param {string} where
 * @param {boolean} named
 * @param {string[]} problems
 */
function checkNode(node, where, named, problems) {
  if ("$ref" in node) {
    const extra = Object.keys(node).filter((k) => !REF_SIBLINGS.has(k));
    if (extra.length > 0) problems.push(`${where}: "$ref" may only sit next to "description", found ${extra.join(", ")}`);
    return;
  }
  if ("const" in node) problems.push(`${where}: use "enum": [value] instead of "const" (typify only enforces enum)`);
  if ("format" in node) problems.push(`${where}: no "format" — use a "pattern" so every language keeps the string as is`);
  if ("properties" in node) {
    if (!named) problems.push(`${where}: inline object type — move it to a named $def`);
    if (node.additionalProperties !== false) problems.push(`${where}: an object with properties needs "additionalProperties": false`);
  }
  if (Array.isArray(node.enum) && node.enum.length > 1 && !named) {
    problems.push(`${where}: inline multi-value enum — move it to a named $def`);
  }
  if (("oneOf" in node || "anyOf" in node) && !named) problems.push(`${where}: inline union — move it to a named $def`);
  if ("anyOf" in node || "allOf" in node) problems.push(`${where}: use "oneOf" (anyOf/allOf are not generated consistently)`);
  if (Array.isArray(node.oneOf)) {
    for (const [i, branch] of node.oneOf.entries()) {
      if (!isObject(branch) || typeof branch.$ref !== "string") {
        problems.push(`${where}/oneOf/${i}: union branches must be $refs to named types`);
      }
    }
  }
  if (typeof node.pattern === "string") {
    if (/\\d/.test(node.pattern)) problems.push(`${where}: use [0-9] instead of \\d (Rust and Python match Unicode digits)`);
    if (/\(\?[=!<]/.test(node.pattern)) problems.push(`${where}: no look-around in patterns`);
  }
}

/**
 * An optional property must not be an inline array or map: typify generates those as a collection
 * that is skipped when empty, which would drop an explicit `[]` or `{}` (lossy).
 *
 * @param {unknown} sub
 * @param {string} where
 * @param {string[]} problems
 */
function checkOptional(sub, where, problems) {
  if (isObject(sub) && (sub.type === "array" || sub.type === "object")) {
    problems.push(`${where}: optional ${sub.type} must be a named $def (so it is not dropped when empty)`);
  }
}
