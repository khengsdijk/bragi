/** The plain-language progress line for an upload / analysis state (11 §8). */
import { t } from "../../../i18n/index.js";
import type { UploadState } from "../../analysis/state/flow.js";

export function progressText(state: UploadState | null): string | null {
  if (state === null) return null;
  switch (state.phase) {
    case "hashing":
      return t("library.analysis.hashing");
    case "checking":
      return t("library.analysis.checking");
    case "uploading":
      return t("library.analysis.uploading");
    case "queueing":
      return t("library.analysis.queueing");
    case "analysing":
      return t("library.analysis.analysing", {
        done: state.stagesDone,
        total: state.stagesTotal,
      });
    case "ready":
      return t("library.analysis.ready");
    case "failed":
      return t("library.analysis.failed", { message: state.message ?? "" });
    default:
      return null;
  }
}
