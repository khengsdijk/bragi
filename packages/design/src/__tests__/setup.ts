/**
 * jsdom is missing a handful of browser APIs that Radix's primitives touch. Stubbing them here
 * keeps every component test free of setup of its own.
 */
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    writable: true,
    configurable: true,
    value: ResizeObserverStub,
  });
}

if (!("scrollIntoView" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    writable: true,
    configurable: true,
    value: () => {},
  });
}

// Pointer capture: jsdom implements the events but not the capture API Radix's Slider uses.
for (const method of ["setPointerCapture", "releasePointerCapture"] as const) {
  if (!(method in Element.prototype)) {
    Object.defineProperty(Element.prototype, method, {
      writable: true,
      configurable: true,
      value: () => {},
    });
  }
}

if (!("hasPointerCapture" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "hasPointerCapture", {
    writable: true,
    configurable: true,
    value: () => true,
  });
}

if (!("matchMedia" in window)) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
