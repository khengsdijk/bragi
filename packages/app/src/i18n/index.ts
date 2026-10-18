/**
 * User-facing strings (13 §3: no hard-coded strings). `en.json` is the source
 * of truth; `t` is typed by it, so a missing or misspelled key is a type error.
 *
 * English only in v1 (11 §2), and the copy rules are asserted by the unit test
 * next to `en.json`: labels and navigation stay short, and no string shouts.
 */
import en from "./en.json" with { type: "json" };

/** Every message key `en.json` defines. */
export type MessageKey = keyof typeof en;

/** Values for `{placeholders}`. */
export type MessageParams = Readonly<Record<string, string | number>>;

/** The raw message table, for tests and for the language guide check. */
export const messages: Readonly<Record<MessageKey, string>> = en;

/**
 * The message for `key`, with `{placeholders}` replaced by `params`.
 *
 * An unknown placeholder is left in place rather than rendered as `undefined`,
 * so a mistake is visible instead of confusing.
 */
export function t(key: MessageKey, params?: MessageParams): string {
  const template: string = en[key];
  if (params === undefined) return template;
  return template.replace(/\{([a-z][a-zA-Z0-9]*)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}
