import { defineConfig } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
function cachedChromium() {
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH)
    return process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (process.platform !== "darwin") return undefined;
  const cache = path.join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cache)) return undefined;
  for (const folder of readdirSync(cache)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort()
    .reverse()) {
    const executable = path.join(
      cache,
      folder,
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    );
    if (existsSync(executable)) return executable;
  }
}
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 90000,
  use: {
    baseURL: "http://127.0.0.1:4318",
    headless: true,
    launchOptions: { executablePath: cachedChromium() },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "tsx scripts/e2e-server.ts",
    url: "http://127.0.0.1:4318/api/health",
    reuseExistingServer: false,
    timeout: 120000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10000 },
  },
});
