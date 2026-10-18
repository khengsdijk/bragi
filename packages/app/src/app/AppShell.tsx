/**
 * The application shell: the header, the navigation and the routed content.
 * Routes are code-based (no codegen plugin) and read as a list.
 */
import { Link, Outlet } from "@tanstack/react-router";

import { t } from "../i18n/index.js";

const NAVIGATION = [
  { to: "/", label: t("nav.projects") },
  { to: "/universe", label: t("nav.universe") },
  { to: "/fuse", label: t("nav.fuse") },
] as const;

export function AppShell() {
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        {t("nav.skipToContent")}
      </a>
      <header className="shell__header">
        <span className="shell__brand" data-testid="app-name">
          {t("app.name")}
        </span>
        <nav aria-label={t("app.name")}>
          <ul className="shell__nav">
            {NAVIGATION.map((item) => (
              <li key={item.to}>
                <Link to={item.to} activeProps={{ "aria-current": "page" }}>
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="main" className="shell__main">
        <Outlet />
      </main>
    </div>
  );
}
