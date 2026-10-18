// Headless runner for the AudioWorklet test page. Serves `web/` and `fixtures/audio/`, launches
// headless Chrome/Chromium, drives it over raw CDP (Node's built-in WebSocket, no npm deps), and
// exits non-zero unless `window.__result.ok` is true.
//
// Usage: `node run.mjs` (run `node build.mjs` first, or let this script build).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const fixtures = join(repo, "fixtures/audio");

if (!existsSync(join(here, "bragi_stretch_worklet.wasm"))) {
  console.log("building wasm…");
  execFileSync("node", [join(here, "build.mjs")], { stdio: "inherit" });
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".wav": "audio/wav",
};

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  file = file.startsWith("/fixtures/")
    ? join(fixtures, file.slice("/fixtures/".length))
    : join(here, file);
  try {
    const body = readFileSync(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

const chrome =
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: a lab script, not a turbo task; CHROME_PATH is a developer override.
  process.env.CHROME_PATH ??
  [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find(existsSync);
if (!chrome) {
  console.error("no Chrome/Chromium found; set CHROME_PATH");
  process.exit(2);
}

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/index.html`;

const userData = mkdtempSync(join(tmpdir(), "bragi-chrome-"));
const child = spawn(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${userData}`,
    pageUrl,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

const devtools = await new Promise((resolvePromise, reject) => {
  const timer = setTimeout(() => reject(new Error("Chrome did not open a DevTools port")), 20000);
  child.stderr.on("data", (d) => {
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(d));
    if (m) {
      clearTimeout(timer);
      resolvePromise(m[1]);
    }
  });
});

async function evaluate(expression, ws) {
  return await new Promise((resolvePromise, reject) => {
    const id = Math.floor(Math.random() * 1e6);
    const onMessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) {
        ws.removeEventListener("message", onMessage);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolvePromise(msg.result);
      }
    };
    ws.addEventListener("message", onMessage);
    ws.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    );
  });
}

const httpBase = `http://${new URL(devtools).host}`;
let pageWs = null;
for (let i = 0; i < 40 && !pageWs; i++) {
  try {
    const targets = await (await fetch(`${httpBase}/json/list`)).json();
    pageWs =
      targets.find((t) => t.type === "page" && t.url.includes("index.html"))
        ?.webSocketDebuggerUrl ?? null;
  } catch {
    // DevTools endpoint not up yet.
  }
  if (!pageWs) await new Promise((r) => setTimeout(r, 250));
}
if (!pageWs) {
  console.error("no page target found");
  child.kill("SIGKILL");
  process.exit(2);
}

const devWs = new WebSocket(pageWs);
await new Promise((r, j) => {
  devWs.addEventListener("open", r);
  devWs.addEventListener("error", j);
});

async function poll() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const r = await evaluate("JSON.stringify(window.__result ?? window.__error ?? null)", devWs);
    const value = r.result?.value;
    if (value && value !== "null") return JSON.parse(value);
    await new Promise((r2) => setTimeout(r2, 250));
  }
  throw new Error("timed out waiting for window.__result");
}

let exitCode = 0;
try {
  const result = await poll();
  console.log(JSON.stringify(result, null, 2));
  if (typeof result === "string" || !result.ok) {
    console.error("AudioWorklet test FAILED");
    exitCode = 1;
  } else {
    console.log("AudioWorklet test PASSED");
  }
} catch (err) {
  console.error(String(err));
  exitCode = 1;
} finally {
  child.kill("SIGKILL");
  devWs.close();
  server.close();
}
process.exit(exitCode);
