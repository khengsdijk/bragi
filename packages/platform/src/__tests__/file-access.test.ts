import { describe, expect, it } from "vitest";

import { isTauriHost } from "../auto.js";
import { createInputFileAccess, type PickerDocument } from "../web/file-access.js";

/** Just enough of an `<input type=file>` to drive the picker without a DOM. */
class FakeInput extends EventTarget {
  type = "";
  multiple = false;
  accept = "";
  hidden = false;
  files: File[] | null = null;
  removed = false;
  constructor(private readonly onClick: (input: FakeInput) => void) {
    super();
  }
  click() {
    this.onClick(this);
  }
  remove() {
    this.removed = true;
  }
}

function fakeDocument(onClick: (input: FakeInput) => void) {
  const inputs: FakeInput[] = [];
  const doc = {
    createElement: () => {
      const input = new FakeInput(onClick);
      inputs.push(input);
      return input as unknown as HTMLInputElement;
    },
    body: { append: () => undefined },
  } satisfies PickerDocument;
  return { doc, inputs };
}

describe("createInputFileAccess", () => {
  it("returns the picked files with lazily read bytes", async () => {
    const { doc, inputs } = fakeDocument((input) => {
      input.files = [new File([new Uint8Array([1, 2, 3])], "a.wav")];
      input.dispatchEvent(new Event("change"));
    });
    const files = await createInputFileAccess(doc).pickFiles({
      accept: ["audio/*", ".flac"],
      multiple: true,
    });
    expect(files.map((f) => [f.name, f.size])).toEqual([["a.wav", 3]]);
    expect(await files[0]?.bytes()).toEqual(new Uint8Array([1, 2, 3]));
    expect(inputs[0]).toMatchObject({
      type: "file",
      accept: "audio/*,.flac",
      multiple: true,
      hidden: true,
      removed: true,
    });
  });

  it("resolves with no files when the user cancels", async () => {
    const { doc, inputs } = fakeDocument((input) => input.dispatchEvent(new Event("cancel")));
    expect(await createInputFileAccess(doc).pickFiles()).toEqual([]);
    expect(inputs[0]?.removed).toBe(true);
  });
});

describe("isTauriHost", () => {
  it("detects the IPC bridge Tauri injects", () => {
    expect(isTauriHost({})).toBe(false);
    expect(isTauriHost({ __TAURI_INTERNALS__: {} })).toBe(true);
  });
});
