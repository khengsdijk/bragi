import type { StorybookConfig } from "@storybook/react-vite";

/**
 * The component workshop: Storybook, not Ladle.
 *
 * Ladle 5 pins Vite 6 and would pull a second, older Vite into a repository on Vite 8;
 * Storybook's `@storybook/react-vite` declares Vite ^5 … ^8 and React ^19, so it is the one
 * that fits the stack (see docs/wp/0.6.md). It is a dev-only tool.
 */
const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  framework: { name: "@storybook/react-vite", options: {} },
  core: {
    disableTelemetry: true,
    disableWhatsNewNotifications: true,
  },
};

export default config;
