/**
 * One project, read back from the local database after a navigation or a reload,
 * together with the state of its stored card. This is the page the end-to-end
 * scenario lands on, so it exposes what it found through `data-testid`s rather
 * than only through copy.
 */
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { t } from "../../../i18n/index.js";
import { usePlatform } from "../../../platform-context.js";
import { getProjectRow } from "../../library/api/library-repo.js";
import { StoredSongCanvas } from "../../song/components/StoredSongCanvas.js";
import { getProject, type Project, verifyProjectCard } from "../api/projects-repo.js";

type SongState =
  | { readonly status: "loading" }
  | { readonly status: "missing" }
  | {
      readonly status: "ready";
      readonly project: Project;
      readonly cardOk: boolean;
      readonly hasSnapshot: boolean;
    };

export function SongPage() {
  const platform = usePlatform();
  const { id } = useParams({ from: "/song/$id" });
  const [state, setState] = useState<SongState>({ status: "loading" });

  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    getProject(platform.localDb, id)
      .then(async (project) => {
        if (project === null) return { status: "missing" } as const;
        const row = await getProjectRow(platform.localDb, id);
        return {
          status: "ready",
          project,
          cardOk: await verifyProjectCard(platform, project),
          hasSnapshot: row?.snapshotHash !== null && row?.snapshotHash !== undefined,
        } as const;
      })
      .then(
        (next) => {
          if (live) setState(next);
        },
        () => {
          if (live) setState({ status: "missing" });
        },
      );
    return () => {
      live = false;
    };
  }, [id, platform]);

  if (state.status === "loading") {
    return <p data-testid="song-loading">{t("song.loading")}</p>;
  }

  if (state.status === "missing") {
    return (
      <section className="song">
        <h1>{t("song.heading")}</h1>
        <p data-testid="song-missing">{t("song.notFound", { id })}</p>
        <Link to="/">{t("song.back")}</Link>
      </section>
    );
  }

  return (
    <section className="song">
      <h1 data-testid="song-title">{state.project.title}</h1>
      <p className="song__id" data-testid="project-id">
        {state.project.id}
      </p>
      <p data-testid="card-status" data-card-ok={state.cardOk ? "true" : "false"}>
        {state.cardOk ? t("song.cardOk") : t("song.cardMissing")}
      </p>
      <Link to="/">{t("song.back")}</Link>
      {state.hasSnapshot ? <StoredSongCanvas projectId={state.project.id} /> : null}
    </section>
  );
}
