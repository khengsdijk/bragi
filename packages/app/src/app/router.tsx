/**
 * The routes (01 §1: TanStack Router, code-based). Four for now: the project
 * list, one project, the Universe and Fuse placeholders.
 *
 * The history is a **hash** history on purpose. The same bundle is served from a
 * plain static host on the web and from Tauri's asset protocol on the desktop
 * (01 §3), and only the hash guarantees that `#/song/prj_…` survives a reload in
 * both without a server rewrite rule. The CDN configuration in 01 §9 can add
 * path routing later; the URL shape is the router's business, not the app's.
 */
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { FusePage } from "../features/fuse/components/FusePage.js";
import { ProjectsPage } from "../features/projects/components/ProjectsPage.js";
import { SongPage } from "../features/projects/components/SongPage.js";
import { DemoSongPage, validateDemoSearch } from "../features/song/components/DemoSongPage.js";
import { UniversePage } from "../features/universe/components/UniversePage.js";
import { AppShell } from "./AppShell.js";

export const rootRoute = createRootRoute({ component: AppShell });

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: ProjectsPage,
});

export const songRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/song/$id",
  component: SongPage,
});

export const demoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/demo",
  validateSearch: validateDemoSearch,
  component: DemoSongPage,
});

export const universeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/universe",
  component: UniversePage,
});

export const fuseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/fuse",
  component: FusePage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  songRoute,
  demoRoute,
  universeRoute,
  fuseRoute,
]);

/**
 * The app's router.
 *
 * Built on demand, not at import time: `createHashHistory` reads `window`, and
 * importing `@bragi/app` in a test runner (or in a worker) must not require a
 * document. Only {@link mountApp} calls this, and only in a page.
 */
export function createAppRouter() {
  return createRouter({ routeTree, history: createHashHistory() });
}

/** The app's router instance type, so route paths are typed through `Register`. */
export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
