import { spawn, execFile } from "node:child_process";
import { createRequire } from "node:module";
import { open, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config, assertConfig } from "../src/server/config";
const pidFile = path.join(config.dataDir, "app.pid"),
  require = createRequire(import.meta.url);
const exec = promisify(execFile),
  runner = path.resolve("scripts/run.ts");
const healthHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
const healthUrl = `http://${healthHost}:${config.port}/api/health`;
async function runningPid() {
  try {
    const pid = Number(await readFile(pidFile, "utf8"));
    if (!Number.isInteger(pid) || pid <= 1) return null;
    process.kill(pid, 0);
    const details = await exec("ps", ["-p", String(pid), "-o", "args="]);
    if (!details.stdout.includes(runner)) return null;
    return pid;
  } catch {
    return null;
  }
}
if (process.argv[2] === "stop") {
  const pid = await runningPid();
  if (!pid) {
    await rm(pidFile, { force: true });
    console.log("No managed background app is running.");
  } else {
    process.kill(pid, "SIGTERM");
    for (let attempt = 0; attempt < 60 && (await runningPid()); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 500));
    if (await runningPid())
      throw new Error(
        "The worker is still shutting down. Wait before restoring data.",
      );
    await rm(pidFile, { force: true });
    console.log("App and worker are stopping. PostgreSQL remains available.");
  }
} else {
  assertConfig();
  if (await runningPid())
    throw new Error(
      "The managed app is already running. Use npm run stop first.",
    );
  try {
    await fetch(healthUrl, {
      signal: AbortSignal.timeout(1000),
    });
    throw new Error(
      `Port ${config.port} already has an HTTP service. Stop it before starting another app.`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Port "))
      throw error;
  }
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const logFile = path.join(config.dataDir, "app.log"),
    log = await open(logFile, "a", 0o600);
  try {
    const child = spawn(process.execPath, ["--import", "tsx", runner], {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    child.unref();
    await writeFile(pidFile, String(child.pid), { mode: 0o600 });
    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        const response = await fetch(healthUrl, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) {
          console.log(
            `App and worker running at http://${config.host}:${config.port}\nLog: ${logFile}\nStop: npm run stop`,
          );
          process.exit(0);
        }
      } catch {
        /* Wait for startup. */
      }
      if (!(await runningPid())) break;
    }
    throw new Error(`Startup failed. Check ${logFile}.`);
  } finally {
    await log.close();
  }
}
