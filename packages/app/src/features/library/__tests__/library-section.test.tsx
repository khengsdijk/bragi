// @vitest-environment jsdom
/**
 * WP-2.0: the welcome page shows the magic-link form only in multi-user mode
 * (ADR-0014). Single-user mode, a host without an API, and a pending or failed
 * mode request all show no form, so the drop zone is the only first step.
 */
import type { ApiClient, AuthModeResponse, RealtimeClient } from "@bragi/api-client";
import type { Platform } from "@bragi/platform";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlatformProvider } from "../../../platform-context.js";
import { LibrarySection, showSignIn } from "../components/LibrarySection.js";

const { getAuthMode } = vi.hoisted(() => ({
  getAuthMode: vi.fn<() => Promise<AuthModeResponse>>(),
}));

vi.mock("../../analysis/api/host.js", () => ({
  apiFor: () => ({ getAuthMode }) as unknown as ApiClient,
  realtimeFor: () => ({ close: () => {} }) as unknown as RealtimeClient,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => () => Promise.resolve(),
}));

const AUTH_MODE = ["auth", "mode"] as const;

function fakePlatform(withApi: boolean): Platform {
  return {
    kind: "memory",
    localDb: {
      query: async () => [],
      run: async () => ({ changes: 0 }),
      transaction: async () => {},
      close: async () => {},
    },
    blobCache: {
      put: async () => "sha256:00" as const,
      get: async () => null,
      has: async () => false,
      delete: async () => {},
    },
    fileAccess: { pickFiles: async () => [] },
    ...(withApi ? { api: { baseUrl: "http://api.test", credential: "cookie" as const } } : {}),
  };
}

function renderLibrary(platform: Platform) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <PlatformProvider platform={platform}>
        <LibrarySection />
      </PlatformProvider>
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  cleanup();
  getAuthMode.mockReset();
});

describe("showSignIn", () => {
  it("is true only for multi-user mode", () => {
    expect(showSignIn("multi-user")).toBe(true);
    expect(showSignIn("single-user")).toBe(false);
    expect(showSignIn(undefined)).toBe(false);
  });
});

describe("the welcome page sign-in form", () => {
  it("is absent in single-user mode", async () => {
    const response: AuthModeResponse = {
      mode: "single-user",
      user: { id: "usr_1", email: "owner@bragi.local", name: "Owner" },
    };
    getAuthMode.mockResolvedValue(response);
    const client = renderLibrary(fakePlatform(true));

    await waitFor(() => expect(client.getQueryData(AUTH_MODE)).toEqual(response));
    expect(document.querySelector("#sign-in-email")).toBeNull();
    expect(screen.getByRole("button", { name: /drop a song/i })).toBeTruthy();
  });

  it("is present in multi-user mode", async () => {
    const response: AuthModeResponse = { mode: "multi-user", user: null };
    getAuthMode.mockResolvedValue(response);
    const client = renderLibrary(fakePlatform(true));

    await waitFor(() => expect(client.getQueryData(AUTH_MODE)).toEqual(response));
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send me a sign-in link" })).toBeTruthy();
  });

  it("is absent when the host has no API", async () => {
    renderLibrary(fakePlatform(false));

    await waitFor(() => expect(screen.getByTestId("library-empty")).toBeTruthy());
    expect(getAuthMode).not.toHaveBeenCalled();
    expect(document.querySelector("#sign-in-email")).toBeNull();
  });

  it("is absent while the mode request is pending", async () => {
    getAuthMode.mockReturnValue(new Promise(() => {}));
    renderLibrary(fakePlatform(true));

    await waitFor(() => expect(getAuthMode).toHaveBeenCalledTimes(1));
    expect(document.querySelector("#sign-in-email")).toBeNull();
  });

  it("is absent when the mode request fails", async () => {
    getAuthMode.mockRejectedValue(new Error("offline"));
    const client = renderLibrary(fakePlatform(true));

    await waitFor(() => expect(client.getQueryState(AUTH_MODE)?.status).toBe("error"));
    expect(document.querySelector("#sign-in-email")).toBeNull();
  });
});
