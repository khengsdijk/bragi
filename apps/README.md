# apps/

Thin platform entry points. All application logic lives in [`packages/app`](../packages/app);
these two directories only wrap it for a browser and for a desktop shell.

| Directory | What it is | Filled by |
|---|---|---|
| [`web/`](web) | Vite entry for the browser build | WP-0.5 |
| [`desktop/`](desktop) | Tauri 2 desktop app | WP-0.5, packaged in WP-6.1 |
