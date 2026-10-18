import type { Decorator, Preview } from "@storybook/react-vite";
import { useEffect } from "react";

import "../base.css";
import "./preview.css";

/**
 * Stories always render inside a themed page, so what you look at is what the app shows:
 * `data-theme` on `<html>` picks the token set, exactly as the app does it.
 */
const withTheme: Decorator = (Story, context) => {
  const theme = String(context.globals.theme ?? "dark");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="story-root">
      <Story />
    </div>
  );
};

const preview: Preview = {
  decorators: [withTheme],
  initialGlobals: { theme: "dark" },
  globalTypes: {
    theme: {
      description: "Bragi theme (specs/11 §3)",
      toolbar: {
        title: "Theme",
        icon: "contrast",
        items: [
          { value: "dark", title: "Dark" },
          { value: "light", title: "Light" },
        ],
        dynamicTitle: true,
      },
    },
  },
  parameters: {
    layout: "fullscreen",
    controls: { expanded: true },
    options: {
      storySort: {
        order: ["Tokens", "Components"],
      },
    },
    // The a11y addon is not installed; axe runs over every story in CI instead
    // (scripts/axe-stories.mjs), which is part of `pnpm verify`.
  },
};

export default preview;
