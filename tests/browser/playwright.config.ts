import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: directory,
  testMatch: ["**/*.e2e.ts"],
  outputDir: path.join(os.tmpdir(), "aeh-s9-playwright-output"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 20 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    headless: true,
    trace: "off",
    screenshot: "off",
    video: "off",
    actionTimeout: 30_000,
    navigationTimeout: 60_000
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], trace: "off", screenshot: "off", video: "off" } }
  ]
});
