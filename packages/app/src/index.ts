/**
 * `@bragi/app`: the application itself — routes, features and views. It is
 * platform-agnostic (13 §1 rule 9): the host passes a `Platform` in, and nothing
 * here imports `@tauri-apps/*`, an adapter or sqlite-wasm.
 *
 * The first surface is the routes from WP-0.5: `/`, `/song/:id`, `/universe`,
 * `/fuse`.
 */
export const PACKAGE_NAME = "@bragi/app";

export {
  createProject,
  getProject,
  listProjects,
  MAX_TITLE_LENGTH,
  newProjectId,
  type Project,
  ProjectTitleError,
  projectCard,
  verifyProjectCard,
} from "./features/projects/api/projects-repo.js";
export { type MessageKey, type MessageParams, t } from "./i18n/index.js";
export { type MountOptions, mountApp } from "./mount.js";
export { PlatformProvider, usePlatform } from "./platform-context.js";
