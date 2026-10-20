/**
 * Settings that live on this device (`local_settings`, 05 §5): the same table the history store
 * keeps its device id in. The repository only knows key/value pairs; the settings store gives each
 * one a type.
 */
import type { LocalDB } from "@bragi/platform";

/** The keys v1 writes. */
export const SMART_TRANSITIONS_KEY = "smartTransitions";

/** One setting as stored, or `null` when it was never written. */
export async function readSetting(db: LocalDB, key: string): Promise<string | null> {
  const rows = await db.query("SELECT value FROM local_settings WHERE key = ?", [key]);
  const value = rows[0]?.value;
  return typeof value === "string" ? value : null;
}

/** Writes a setting, creating it or replacing it. */
export async function writeSetting(db: LocalDB, key: string, value: string): Promise<void> {
  await db.run(
    `INSERT INTO local_settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

/** Smart transitions default on (07 §4.1, 11 §9). */
export async function readSmartTransitions(db: LocalDB): Promise<boolean> {
  return (await readSetting(db, SMART_TRANSITIONS_KEY)) !== "false";
}

export async function writeSmartTransitions(db: LocalDB, value: boolean): Promise<void> {
  await writeSetting(db, SMART_TRANSITIONS_KEY, value ? "true" : "false");
}
