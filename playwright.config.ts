import { defineConfig } from "@playwright/test";

const repositoryRoot = import.meta.dirname;

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4199",
    browserName: "chromium",
    headless: true,
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    },
  },
  webServer: {
    command:
      "pnpm --filter @indexary/server start -- --knowledge-base fixtures/knowledge-base --profile browser --port 4199 --web-root apps/web/dist",
    cwd: repositoryRoot,
    url: "http://127.0.0.1:4199/api/health/ready",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
