import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { config, assertConfig } from "../src/server/config";
import { migrate, pool } from "../src/server/db";
import { docker } from "./docker";
assertConfig();
try {
  await pool.query("SELECT 1");
} catch {
  await docker(["compose", "--env-file", ".env.local", "up", "-d", "db"]);
  for (let i = 0; i < 30; i++) {
    try {
      await pool.query("SELECT 1");
      break;
    } catch {
      if (i === 29) throw new Error("Database did not become ready.");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
await migrate();
await pool.end();
const require = createRequire(import.meta.url),
  development = process.argv[2] === "dev";
const worker = spawn(
  process.execPath,
  ["--import", "tsx", "scripts/worker.ts"],
  { stdio: "inherit", env: process.env },
);
const web = spawn(
  process.execPath,
  [
    require.resolve("next/dist/bin/next"),
    development ? "dev" : "start",
    "--hostname",
    config.host,
    "--port",
    String(config.port),
  ],
  { stdio: "inherit", env: process.env },
);
let stopping = false;
const stop = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  const finished = Promise.all(
    [worker, web].map((child) =>
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => child.once("exit", () => resolve())),
    ),
  );
  worker.kill("SIGTERM");
  web.kill("SIGTERM");
  const deadline = setTimeout(() => {
    worker.kill("SIGKILL");
    web.kill("SIGKILL");
    process.exit(code || 1);
  }, 25000);
  await finished;
  clearTimeout(deadline);
  process.exit(code);
};
worker.on("exit", (code) => {
  if (!stopping) {
    console.error(
      "Background worker stopped. Restart the app to resume imports.",
    );
    stop(code || 1);
  }
});
web.on("exit", (code) => stop(code || 0));
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
console.log(
  `Expenses is starting at http://${config.host}:${config.port}. Proxy ${config.appUrl} to this address.`,
);
