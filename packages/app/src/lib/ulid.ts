/**
 * ULIDs for locally created entities (02 §2.1: `prj_` + ULID).
 *
 * A ULID is 26 Crockford base32 characters: 10 for the millisecond timestamp
 * (48 bits) and 16 for 80 random bits. Sorted as text, ULIDs sort by creation
 * time, which is why the project list can order by id as a tie-breaker.
 *
 * Deliberately dependency-free and deterministic under test: the random source
 * is a parameter.
 */

/** Crockford base32: no `I`, `L`, `O` or `U`, so no two ids are visually ambiguous. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The 48-bit timestamp field's maximum, 10889-08-02T05:31:50.655Z. */
export const MAX_TIMESTAMP = 2 ** 48 - 1;

/** Where the 80 random bits come from. */
export type RandomBytes = (length: number) => Uint8Array;

const webCrypto: RandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));

/**
 * A 26-character ULID for `timestamp` (milliseconds since the epoch).
 *
 * @throws {RangeError} when the timestamp does not fit the 48-bit field.
 */
export function ulid(timestamp: number = Date.now(), random: RandomBytes = webCrypto): string {
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > MAX_TIMESTAMP) {
    throw new RangeError(`Timestamp ${timestamp} does not fit a ULID's 48-bit field`);
  }

  let id = "";
  for (let index = 0; index < 10; index += 1) {
    // The most significant character first: 5 bits each, 50 bits for 48 bits of
    // time, so the two leading bits are always zero.
    const group = Math.floor(timestamp / 2 ** (45 - index * 5)) % 32;
    id += ALPHABET[group];
  }

  const bytes = random(10);
  for (let index = 0; index < 16; index += 1) {
    // Each character takes the next 5 bits of the 80-bit field.
    let value = 0;
    for (let bit = 0; bit < 5; bit += 1) {
      const position = index * 5 + bit;
      const byte = bytes[position >> 3] ?? 0;
      value = (value << 1) | ((byte >> (7 - (position & 7))) & 1);
    }
    id += ALPHABET[value];
  }
  return id;
}
