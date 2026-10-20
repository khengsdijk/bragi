/**
 * Node resolve hook for the planner bench: TypeScript sources import `./foo.js` (the extension
 * their compiled output uses), which Node's type stripping would not find next to `foo.ts`.
 *
 * Registered with `--import`, so `pnpm bench:planner` can run `run.ts` directly with no new
 * dependency. The hook only rewrites a relative `.js` specifier when the sibling `.ts` exists.
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  // Rewrites `./x.js` to `./x.ts` when the sibling TypeScript source exists; everything else is
  // resolved normally.
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL !== undefined) {
      const target = new URL(specifier, context.parentURL);
      const source = new URL(target.href.replace(/\.js$/, ".ts"));
      if (existsSync(fileURLToPath(source))) {
        return { url: source.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
