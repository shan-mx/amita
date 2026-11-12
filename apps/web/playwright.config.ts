import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const origin = process.env.AMITA_TEST_ORIGIN ?? "http://127.0.0.1:5190";
export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "*.pw.ts",
  timeout: 20_000,
  use: { baseURL: origin, viewport: { width: 1440, height: 1000 } },
  webServer: process.env.AMITA_TEST_ORIGIN
    ? undefined
    : {
        command: "pnpm --filter @amita/web dev --port 5190",
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        url: origin,
        reuseExistingServer: false,
      },
  outputDir: "../../.scratch/playwright-results",
  reporter: "list",
});
