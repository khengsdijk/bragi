/**
 * The one piece of state the app gets from its host: the `Platform`
 * (01 §3). `apps/web` builds it with `@bragi/platform/auto` — which is why this
 * package can stay ignorant of Tauri, of sqlite-wasm and of OPFS — and provides
 * it here; components read it with {@link usePlatform}.
 */

import type { Platform } from "@bragi/platform";
import { createContext, type ReactNode, useContext } from "react";

const PlatformContext = createContext<Platform | null>(null);

export function PlatformProvider({
  platform,
  children,
}: {
  readonly platform: Platform;
  readonly children: ReactNode;
}): ReactNode {
  return <PlatformContext value={platform}>{children}</PlatformContext>;
}

/** The host's platform. Throws outside a {@link PlatformProvider}, which is a bug, not a state. */
export function usePlatform(): Platform {
  const platform = useContext(PlatformContext);
  if (platform === null) {
    throw new Error("usePlatform was called outside a PlatformProvider");
  }
  return platform;
}
