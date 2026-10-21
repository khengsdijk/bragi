/**
 * The planner's capability catalogue (06 §2, §4).
 *
 * Built from the generated DSP catalogues, so it cannot describe an fx parameter or macro that the
 * model does not have. It carries IDs and numbers only: no prose, no labels, no help text. Op
 * names and shapes live in the generated `OP SHAPES` block (`opSchemas.ts`), so they are not
 * repeated here. Generation capabilities are an empty registry in v1 (WP-2.7 fills it).
 */
import { FX_CATALOG, MACROS } from "@bragi/schemas";

/** One parameter: numeric ranges where the catalogue has them. */
export interface CatalogueParam {
  min?: number;
  max?: number;
  default?: number;
  type?: string;
}

/** The catalogue as the model sees it, serialised compactly into the user message. */
export interface CapabilityCatalogue {
  fx: Record<string, Record<string, CatalogueParam>>;
  macros: Record<string, { min: number; max: number }>;
  generation: unknown[];
}

/**
 * Builds the catalogue from the generated DSP catalogues.
 *
 * @returns the catalogue, deterministic for a given DSP catalogue
 */
export function buildCatalogue(): CapabilityCatalogue {
  return {
    fx: fxCatalogue(),
    macros: Object.fromEntries(
      MACROS.macros.map((macro) => [macro.id, { min: macro.range[0], max: macro.range[1] }]),
    ),
    generation: [],
  };
}

/** The catalogue as one compact JSON line for the prompt. */
export function catalogueText(catalogue: CapabilityCatalogue = buildCatalogue()): string {
  return JSON.stringify(catalogue);
}

/** Numeric ranges per fx type and parameter, from `fx_catalog.json`. */
function fxCatalogue(): Record<string, Record<string, CatalogueParam>> {
  const out: Record<string, Record<string, CatalogueParam>> = {};
  for (const [type, definition] of Object.entries(FX_CATALOG.fx)) {
    const params: Record<string, CatalogueParam> = {};
    for (const [name, spec] of Object.entries(definition.params)) {
      params[name] =
        "min" in spec
          ? { min: spec.min, max: spec.max, default: spec.default }
          : { type: spec.type };
    }
    out[type] = params;
  }
  return out;
}
