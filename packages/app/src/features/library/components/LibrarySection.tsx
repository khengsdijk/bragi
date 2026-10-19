/**
 * The library / welcome section: drop a song, watch it come alive, open it again
 * (01 §6, 07 §8).
 *
 * It is the only place that starts an upload flow and the only place that talks
 * to the API for the library. Local rows come from `library-repo` through a
 * TanStack Query cache; the flow owns the hash/upload/analysis pipeline.
 */

import type { AuthMode } from "@bragi/api-client";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { t } from "../../../i18n/index.js";
import { usePlatform } from "../../../platform-context.js";
import { apiFor, realtimeFor } from "../../analysis/api/host.js";
import { createUploadFlow, type UploadFlow, type UploadState } from "../../analysis/state/flow.js";
import { loadModel } from "../../song/model/model-api.js";
import { createSongStore } from "../../song/state/song-store.js";
import { type LibraryItem, listLibraryItems } from "../api/library-repo.js";
import { progressText } from "./progress.js";

const LOCAL_LIBRARY = ["library", "local"] as const;
const AUTH_MODE = ["auth", "mode"] as const;

/**
 * Whether the welcome page shows the magic-link form (ADR-0014). Only multi-user
 * mode signs in; single-user mode, a pending request and a failed one show no form.
 */
export function showSignIn(mode: AuthMode | undefined): boolean {
  return mode === "multi-user";
}

export function LibrarySection() {
  const platform = usePlatform();
  const navigate = useNavigate();
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [email, setEmail] = useState("");
  const [linkSent, setLinkSent] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const cleanup = useRef<(() => void)[]>([]);
  const input = useRef<HTMLInputElement | null>(null);

  const library = useQuery({
    queryKey: LOCAL_LIBRARY,
    queryFn: () => listLibraryItems(platform.localDb),
  });

  // The host without an API (the in-memory test platform) has no mode to ask
  // for, so the query stays off and the sign-in form stays hidden.
  const authMode = useQuery({
    queryKey: AUTH_MODE,
    queryFn: () => apiFor(platform).getAuthMode(),
    enabled: platform.api !== undefined,
  });

  useEffect(
    () => () => {
      for (const dispose of cleanup.current) dispose();
      cleanup.current = [];
    },
    [],
  );

  const startFile = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      const songStore = createSongStore(await loadModel());
      const realtime = realtimeFor(platform);
      const flow: UploadFlow = createUploadFlow({
        platform,
        api: apiFor(platform),
        realtime,
        songStore,
        onState: setUpload,
        onProject: (projectId) => {
          void navigate({ to: "/song/$id", params: { id: projectId } });
        },
      });
      cleanup.current.push(
        () => flow.dispose(),
        () => realtime.close(),
        () => songStore.dispose(),
      );
      try {
        await flow.start({
          name: file.name,
          bytes: async () => new Uint8Array(await file.arrayBuffer()),
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [navigate, platform],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLButtonElement>) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files[0];
      if (file !== undefined && !busy) void startFile(file);
    },
    [busy, startFile],
  );

  const onPick = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file !== undefined && !busy) void startFile(file);
      event.target.value = "";
    },
    [busy, startFile],
  );

  const signIn = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      setSignInError(null);
      try {
        await apiFor(platform).signInWithEmail(
          email,
          typeof window === "undefined" ? undefined : window.location.href,
        );
        setLinkSent(true);
      } catch {
        setSignInError(t("library.signIn.failed"));
      }
    },
    [email, platform],
  );

  const message = progressText(upload);

  return (
    <section className="library" aria-labelledby="library-heading">
      <h1 id="library-heading">{t("library.heading")}</h1>

      <button
        type="button"
        className={`library__drop${dragging ? " library__drop--over" : ""}`}
        onClick={() => input.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <span className="library__drop-title">{t("library.drop")}</span>
        <span className="library__choose">{t("library.choose")}</span>
      </button>
      <input
        ref={input}
        type="file"
        className="sr-only"
        aria-label={t("library.choose")}
        tabIndex={-1}
        accept="audio/*,.wav,.flac,.mp3,.m4a,.ogg,.opus"
        onChange={onPick}
        disabled={busy}
        data-testid="library-file"
      />

      {message === null ? null : (
        <p role="status" data-testid="library-progress">
          {message}
        </p>
      )}
      {error === null ? null : (
        <p role="alert" data-testid="library-error">
          {error}
        </p>
      )}

      {library.data === undefined ? null : library.data.length === 0 ? (
        <p data-testid="library-empty">{t("library.empty")}</p>
      ) : (
        <ul className="library__list">
          {library.data.map((item: LibraryItem) => (
            <li key={item.id} data-testid="library-row">
              {item.projectId === null ? (
                (item.title ?? item.filename)
              ) : (
                <Link to="/song/$id" params={{ id: item.projectId }}>
                  {item.title ?? item.filename}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}

      {showSignIn(authMode.data?.mode) ? (
        <form className="library__sign-in" onSubmit={signIn} noValidate>
          <h2>{t("library.signIn.heading")}</h2>
          <label htmlFor="sign-in-email">{t("library.signIn.email")}</label>
          <input
            id="sign-in-email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={signInError !== null}
          />
          <button type="submit">{t("library.signIn.send")}</button>
          {linkSent ? <p role="status">{t("library.signIn.sent")}</p> : null}
          {signInError === null ? null : <p role="alert">{signInError}</p>}
        </form>
      ) : null}
    </section>
  );
}
