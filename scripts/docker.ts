import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
export function dockerCommand(args: string[]) {
  if (
    spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      stdio: "ignore",
      timeout: 5000,
    }).status === 0
  )
    return { command: "docker", args };
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  return {
    command: "colima",
    args: [
      "ssh",
      "--",
      "sh",
      "-c",
      `cd ${quote(path.resolve("."))} && docker ${args.map(quote).join(" ")}`,
    ],
  };
}
export async function docker(args: string[], input?: Buffer): Promise<Buffer> {
  const command = dockerCommand(args),
    child = spawn(command.command, command.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
  const chunks: Buffer[] = [],
    errors: Buffer[] = [];
  child.stdout.on("data", (value) => chunks.push(value));
  child.stderr.on("data", (value) => errors.push(value));
  if (input) child.stdin.end(input);
  else child.stdin.end();
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(
            new Error(
              `Database container command failed (exit ${code}). Check that Docker or Colima is running.`,
            ),
          ),
    );
  });
}
