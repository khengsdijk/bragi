/** Normalises whatever an adapter caught (Tauri sends strings, workers send plain objects) into an `Error`. */
export function toError(cause: unknown, context: string): Error {
  if (cause instanceof Error) return cause;
  if (typeof cause === "string") return new Error(`${context}: ${cause}`);
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const { message } = cause;
    if (typeof message === "string") return new Error(`${context}: ${message}`);
  }
  return new Error(`${context}: ${String(cause)}`);
}

/** The error every LocalDB call rejects with after `close()`. */
export function closedError(): Error {
  return new Error("LocalDB is closed");
}
