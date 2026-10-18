/**
 * The in-page driver, evaluated inside the Tauri webview's window by the
 * `selftest` cargo feature (`apps/desktop/src-tauri/src/selftest.rs`).
 *
 * It drives the same UI the same way, through the DOM: it looks controls up by
 * their visible text, fills a field through the same events a person produces
 * (`input`, with React's own value tracker satisfied), and clicks through
 * `HTMLElement.click()`. What it does **not** produce is OS-level input events
 * (no real mouse or keyboard), which is why the scenario asserts on what the app
 * shows rather than on hover/focus behaviour.
 *
 * Every lookup waits, because the app renders asynchronously: the project list
 * arrives from the storage worker.
 */
import type { ScenarioDriver } from "./scenario.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const POLL_MS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface DomDriverOptions {
  readonly timeoutMs?: number;
}

export function createDomDriver(
  doc: Document,
  options: DomDriverOptions = {},
): ScenarioDriver & { readonly lines: readonly string[] } {
  const win = doc.defaultView;
  if (win === null) throw new Error("the document has no window");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lines: string[] = [];

  async function waitFor<T>(what: string, read: () => T | null): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = read();
      if (value !== null) return value;
      if (Date.now() > deadline) {
        // The app renders its own reason for failing to start; passing it on
        // makes a harness failure readable instead of a bare timeout.
        const fatal = textOf(byTestId("fatal-error"));
        throw new Error(
          `timed out after ${timeoutMs} ms waiting for ${what}${fatal === "" ? "" : ` (the page reports: ${fatal})`}`,
        );
      }
      await sleep(POLL_MS);
    }
  }

  const byTestId = (testId: string): Element | null =>
    doc.querySelector(`[data-testid="${testId}"]`);

  const textOf = (element: Element | null) => (element?.textContent ?? "").trim();

  /** Every control a person could click, in document order. */
  const controls = (): HTMLElement[] =>
    Array.from(
      doc.querySelectorAll<HTMLElement>("a, button, [role='button'], input[type='submit']"),
    );

  return {
    async goto(route) {
      const target = `#${route}`;
      if (win.location.hash !== target) {
        // A fragment navigation. Browsers fire `hashchange` for this and
        // `popstate` only on a traversal, and @tanstack/history listens for
        // `popstate`, so fire it explicitly rather than depend on the browser
        // echoing one. Setting `location.hash` itself does the history bookkeeping.
        win.location.hash = target;
        win.dispatchEvent(new win.PopStateEvent("popstate", { state: win.history.state }));
      }
      // Wait for the router to have re-rendered: `#root` always holds the shell.
      await waitFor("the app shell", () => doc.querySelector("#root .shell"));
    },
    crossOriginIsolated: async () =>
      Boolean((win as { crossOriginIsolated?: unknown }).crossOriginIsolated),
    text: async (testId) =>
      textOf(await waitFor(`[data-testid=${testId}]`, () => byTestId(testId))),
    attribute: async (testId, name) =>
      (await waitFor(`[data-testid=${testId}]`, () => byTestId(testId))).getAttribute(name),
    count: async (testId) => doc.querySelectorAll(`[data-testid="${testId}"]`).length,
    async click(label) {
      const control = await waitFor(`a control named ${JSON.stringify(label)}`, () => {
        return (
          controls().find(
            (element) =>
              textOf(element) === label &&
              !element.hasAttribute("disabled") &&
              element.getAttribute("aria-disabled") !== "true",
          ) ?? null
        );
      });
      control.click();
    },
    async fill(label, value) {
      const field = await waitFor(`a field labelled ${JSON.stringify(label)}`, () => {
        const found = findLabelledField(doc, label);
        return found === null || found.readOnly ? null : found;
      });
      setValueAsAUserWould(field, value);
    },
    log(line) {
      lines.push(line);
      // Visible in the webview's console, which the harness shows on failure.
      console.log(`[selftest] ${line}`);
    },
    get lines() {
      return lines;
    },
  };
}

/**
 * The field a person would type into: a `<label>` whose text is `label`,
 * associated through `for`/`id` or by wrapping the control.
 */
function findLabelledField(
  doc: Document,
  label: string,
): HTMLInputElement | HTMLTextAreaElement | null {
  const wanted = label.trim();
  for (const element of Array.from(doc.querySelectorAll("label"))) {
    if ((element.textContent ?? "").trim() !== wanted) continue;
    const id = element.getAttribute("for");
    const target = id === null ? element.querySelector("input, textarea") : doc.getElementById(id);
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      return target;
    }
  }
  const byAriaLabel = doc.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `input[aria-label="${wanted}"], textarea[aria-label="${wanted}"]`,
  );
  return byAriaLabel;
}

/**
 * Sets a controlled field's value the way typing does.
 *
 * React tracks a field's value on the element itself, so assigning `.value`
 * directly is invisible to it; going through the prototype's setter and then
 * dispatching a bubbling `input` event is what makes React see the change.
 */
function setValueAsAUserWould(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter === undefined) throw new Error("the field has no value setter");
  setter.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
}
