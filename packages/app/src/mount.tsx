/**
 * Mounts the application into a host page (13 §1 rule 9): the host builds the
 * `Platform` — `apps/web` does it with `@bragi/platform/auto`, which is the only
 * code that decides between the browser and the desktop adapters — and passes it
 * in. Nothing in here mentions Tauri, sqlite-wasm or OPFS.
 */

import type { Platform } from "@bragi/platform";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { createAppRouter } from "./app/router.js";
import { PlatformProvider } from "./platform-context.js";

export interface MountOptions {
  /** The host's adapters. */
  readonly platform: Platform;
  /** The element to render into, usually `document.getElementById("root")`. */
  readonly container: HTMLElement;
}

/** Renders the app into `container` and returns a function that tears it down. */
export function mountApp({ platform, container }: MountOptions): () => void {
  const root = createRoot(container);
  root.render(
    <StrictMode>
      <PlatformProvider platform={platform}>
        <RouterProvider router={createAppRouter()} />
      </PlatformProvider>
    </StrictMode>,
  );
  return () => root.unmount();
}
