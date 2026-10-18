import type { FileAccess, PickedFile, PickFilesOptions } from "../types.js";

/** The parts of `Document` the picker needs, so it can be tested without a DOM. */
export interface PickerDocument {
  createElement(tag: "input"): HTMLInputElement;
  readonly body: { append(node: HTMLInputElement): void };
}

const toPicked = (file: File): PickedFile => ({
  name: file.name,
  size: file.size,
  bytes: async () => new Uint8Array(await file.arrayBuffer()),
});

/**
 * FileAccess through a hidden `<input type="file">` — works in every browser
 * and in every Tauri webview. Resolves with `[]` when the user cancels.
 *
 * Chromium's File System Access API and native desktop dialogs/watched folders
 * (01 §3) arrive with library import; this is the floor they build on.
 */
export function createInputFileAccess(doc: PickerDocument): FileAccess {
  return {
    pickFiles(options: PickFilesOptions = {}) {
      return new Promise<PickedFile[]>((resolve) => {
        const input = doc.createElement("input");
        input.type = "file";
        input.multiple = options.multiple ?? false;
        if (options.accept?.length) input.accept = options.accept.join(",");
        input.hidden = true;
        const finish = (files: PickedFile[]) => {
          input.remove();
          resolve(files);
        };
        input.addEventListener("change", () => finish([...(input.files ?? [])].map(toPicked)), {
          once: true,
        });
        input.addEventListener("cancel", () => finish([]), { once: true });
        doc.body.append(input);
        input.click();
      });
    },
  };
}
