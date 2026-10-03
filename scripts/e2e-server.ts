import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isolatedDatabase } from "./test-database";
const database = await isolatedDatabase("browser"),
  dataDir = await mkdtemp(path.join(tmpdir(), "expenses-browser-"));
const require = createRequire(import.meta.url);
const child = spawn(
  process.execPath,
  [require.resolve("tsx/cli"), "scripts/run.ts", "dev"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: database.url,
      DATA_DIR: dataDir,
      PORT: "4318",
      HOST: "127.0.0.1",
      APP_URL: "http://127.0.0.1:4318",
      ACCESS_URL: "http://127.0.0.1:4318",
      NEXT_DIST_DIR: ".next-e2e",
      OWNER_SETUP_TOKEN: "expenses-test-setup-token-only",
      INBOUND_EMAIL_TOKEN: "expenses-test-email-token-only",
      ENABLE_BANKING_APP_ID: "",
      ENABLE_BANKING_PRIVATE_KEY_PATH: "",
    },
  },
);
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await database.dispose();
  await rm(dataDir, { recursive: true, force: true });
  process.exit(code);
}
child.on("exit", (code) => {
  void stop(code || 0);
});
process.on("SIGTERM", () => {
  void stop();
});
process.on("SIGINT", () => {
  void stop();
});
