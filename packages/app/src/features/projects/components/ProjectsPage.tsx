/**
 * The project list and the "New project" form. Everything here reads and writes
 * through {@link createProject} / {@link listProjects}, so the same statements
 * run on both hosts.
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import { t } from "../../../i18n/index.js";
import { usePlatform } from "../../../platform-context.js";
import {
  createProject,
  listProjects,
  type Project,
  ProjectTitleError,
} from "../api/projects-repo.js";

type ListState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly projects: readonly Project[] }
  | { readonly status: "error" };

export function ProjectsPage() {
  const platform = usePlatform();
  const navigate = useNavigate();
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [title, setTitle] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setList({ status: "loading" });
    listProjects(platform.localDb).then(
      (projects) => {
        if (live) setList({ status: "ready", projects });
      },
      () => {
        if (live) setList({ status: "error" });
      },
    );
    return () => {
      live = false;
    };
  }, [platform, attempt]);

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      setCreating(true);
      setFormError(null);
      try {
        const project = await createProject(platform, title);
        await navigate({ to: "/song/$id", params: { id: project.id } });
      } catch (cause) {
        setFormError(
          cause instanceof ProjectTitleError ? cause.message : t("projects.createFailed"),
        );
      } finally {
        setCreating(false);
      }
    },
    [navigate, platform, title],
  );

  return (
    <section className="projects">
      <h1>{t("projects.heading")}</h1>

      <form className="projects__new" onSubmit={submit} noValidate>
        <label htmlFor="project-title">{t("projects.nameLabel")}</label>
        <input
          id="project-title"
          name="title"
          type="text"
          autoComplete="off"
          value={title}
          aria-invalid={formError !== null}
          aria-describedby={formError === null ? undefined : "project-title-error"}
          onChange={(event) => setTitle(event.target.value)}
        />
        <button type="submit" disabled={creating}>
          {t("projects.create")}
        </button>
        {formError === null ? null : (
          <p id="project-title-error" role="alert" data-testid="project-title-error">
            {formError}
          </p>
        )}
      </form>

      {list.status === "loading" ? (
        <p data-testid="projects-loading">{t("projects.loading")}</p>
      ) : null}

      {list.status === "error" ? (
        <p role="alert" data-testid="projects-error">
          {t("projects.error")}{" "}
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            {t("projects.retry")}
          </button>
        </p>
      ) : null}

      {list.status === "ready" && list.projects.length === 0 ? (
        <p data-testid="projects-empty">{t("projects.empty")}</p>
      ) : null}

      {list.status === "ready" && list.projects.length > 0 ? (
        <ul className="projects__list">
          {list.projects.map((project) => (
            <li key={project.id} data-testid="project-row">
              <Link to="/song/$id" params={{ id: project.id }}>
                {project.title}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
