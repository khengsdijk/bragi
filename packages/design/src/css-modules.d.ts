/**
 * Stylesheets are handled by the bundler, not by TypeScript. The two patterns below are what the
 * components import: CSS Modules (typed as a class-name map) and plain stylesheets for their
 * side effect.
 */

declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

declare module "*.css";
