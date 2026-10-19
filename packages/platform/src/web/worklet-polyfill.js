// @ts-nocheck -- runs in AudioWorkletGlobalScope, which the DOM lib does not describe.
/**
 * `TextDecoder` and `TextEncoder` for an AudioWorklet.
 *
 * The Encoding API is not exposed in `AudioWorkletGlobalScope`, and the wasm-bindgen glue
 * constructs a `TextDecoder` at module load, so this file has to be evaluated first. It is a
 * UTF-8 only implementation, enough for the strings the engine glue passes (asset hashes, JSON,
 * error messages). It is imported for its side effect by `engine-processor.js`.
 */

if (typeof globalThis.TextDecoder === "undefined") {
  globalThis.TextDecoder = class TextDecoder {
    constructor() {
      this.encoding = "utf-8";
    }

    decode(input) {
      if (input === undefined) return "";
      const bytes =
        input instanceof Uint8Array
          ? input
          : new Uint8Array(input.buffer ?? input, input.byteOffset ?? 0, input.byteLength);
      let out = "";
      let index = 0;
      while (index < bytes.length) {
        const b0 = bytes[index++];
        if (b0 < 0x80) {
          out += String.fromCharCode(b0);
        } else if (b0 < 0xe0) {
          out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[index++] & 0x3f));
        } else if (b0 < 0xf0) {
          const b1 = bytes[index++];
          const b2 = bytes[index++];
          out += String.fromCharCode(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
        } else {
          const b1 = bytes[index++];
          const b2 = bytes[index++];
          const b3 = bytes[index++];
          const code =
            (((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f)) -
            0x10000;
          out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
        }
      }
      return out;
    }
  };
}

if (typeof globalThis.TextEncoder === "undefined") {
  globalThis.TextEncoder = class TextEncoder {
    constructor() {
      this.encoding = "utf-8";
    }

    encode(text = "") {
      const bytes = [];
      for (const char of text) {
        const code = char.codePointAt(0);
        if (code < 0x80) {
          bytes.push(code);
        } else if (code < 0x800) {
          bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else if (code < 0x10000) {
          bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        } else {
          bytes.push(
            0xf0 | (code >> 18),
            0x80 | ((code >> 12) & 0x3f),
            0x80 | ((code >> 6) & 0x3f),
            0x80 | (code & 0x3f),
          );
        }
      }
      return new Uint8Array(bytes);
    }

    encodeInto(text, target) {
      const encoded = this.encode(text);
      const written = Math.min(encoded.length, target.length);
      target.set(encoded.subarray(0, written));
      return { read: text.length, written };
    }
  };
}
