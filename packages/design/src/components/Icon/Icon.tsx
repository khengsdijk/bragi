import type { ReactNode } from "react";

/** A 1em glyph that scales with the button's font size. */
export function Icon({ children }: { readonly children: ReactNode }) {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}
