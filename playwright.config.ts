import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/production",
  // Playwright clears this directory; preserve unrelated benchmark/review evidence.
  outputDir: "./test-results/production",
  timeout: 60_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://127.0.0.1:5188", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: "node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5188 --strictPort",
    url: "http://127.0.0.1:5188",
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "chromium-phone", use: { ...devices["Pixel 5"], viewport: { width: 320, height: 740 }, deviceScaleFactor: 1 } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "webkit-phone", use: { ...devices["iPhone 13"] } },
  ],
});
