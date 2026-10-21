/** Parses a model reply that should be JSON but may be wrapped in a Markdown fence. */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

/**
 * Unwraps the plan envelope's JSON-encoded lists (06 §5).
 *
 * Some providers return `"variants"` (or a step's `"ops"`) as a JSON string instead of the array
 * the schema asks for, which is a transport quirk rather than a plan mistake. Parsing it here lets
 * the repair round spend its one call on real errors.
 *
 * Only the envelope is unwrapped: op contents are never rewritten (`trackId` is not guessed into
 * `scope`; that mistake goes through validation). A string that does not parse to an array is left
 * untouched for the schema to reject.
 *
 * @param value the parsed reply
 * @returns the same shape, with stringified `variants`, `steps` and `ops` arrays parsed
 */
export function normalizePlanEnvelope(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const variants = arrayOrJson(value.variants);
  if (variants === undefined) return value;
  return { ...value, variants: variants.map(normalizeVariant) };
}

/** Unwraps one variant's `steps`. */
function normalizeVariant(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const steps = arrayOrJson(value.steps);
  return steps === undefined ? value : { ...value, steps: steps.map(normalizeStep) };
}

/** Unwraps one ops step's `ops`. */
function normalizeStep(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const ops = arrayOrJson(value.ops);
  return ops === undefined ? value : { ...value, ops };
}

/** The value when it is an array, or a string that parses to one. */
function arrayOrJson(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    // The provider sometimes appends a stray brace after the array (seen with Haiku); the array
    // itself is intact, so try the first complete JSON array before giving up.
    return firstJsonArray(value);
  }
}

/** The first complete JSON array in a string, ignoring anything after it. */
function firstJsonArray(text: string): unknown[] | undefined {
  const start = text.indexOf("[");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "[" || character === "{") {
      depth += 1;
    } else if (character === "]" || character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, index + 1));
          return Array.isArray(parsed) ? parsed : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** A plain object, not an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
