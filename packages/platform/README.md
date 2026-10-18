# @bragi/platform

The seam between the application and whatever it is running on. **Every difference between web and
desktop lives here** — [`@bragi/app`](../app) does not know which platform it is on and must never
import `@tauri-apps/*` ([01 §3](../../specs/01-architecture.md),
[13 §1](../../specs/13-agent-guide.md)).

| Interface | Browser | Desktop (Tauri) |
|---|---|---|
| `EngineHost` | `bragi-engine` as WASM in an AudioWorklet, commands/meters over SharedArrayBuffer | native engine in the Tauri process via IPC, cpal output |
| `LocalDB` | sqlite-wasm on OPFS, in a Worker | Tauri command → rusqlite |
| `BlobCache` | OPFS | app data directory |
| `FileAccess` | File System Access API / `<input>` | native dialogs, watched folders |
| `Auth` | cookie session | PKCE in the system browser → `bragi://auth/callback`, token in the OS keychain |

One SQLite schema and one migration set serve both, shared from
[`@bragi/schemas`](../schemas).

**Status:** scaffold only. Filled by **WP-0.5**, whose acceptance is that one e2e test (create a
project, store it, reload, read it back) passes in Chromium, Firefox, Safari and in Tauri on all
three desktop OSes.
