import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  readdir,
  copyFile,
  open,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import { docker } from "./docker";
const exec = promisify(execFile);
const magic = Buffer.from("EXPENSES1");
const dbArgs = (url: string) => {
  const parsed = new URL(url);
  return [
    "--username",
    decodeURIComponent(parsed.username),
    "--dbname",
    decodeURIComponent(parsed.pathname.slice(1)),
  ];
};
async function copyDocuments(source: string, target: string) {
  for (const folder of ["receipts", "emails"]) {
    await mkdir(path.join(target, folder), { recursive: true, mode: 0o700 });
    const files = await readdir(path.join(source, folder), {
      withFileTypes: true,
    }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const file of files)
      if (file.isFile()) {
        const destination = path.join(target, folder, file.name);
        await copyFile(path.join(source, folder, file.name), destination);
        await chmod(destination, 0o600);
      }
  }
}
export async function writeBackup(
  databaseUrl: string,
  dataDir: string,
  key: string,
  output: string,
) {
  const temporary = await mkdtemp(path.join(tmpdir(), "expenses-backup-"));
  const partial = `${output}.partial`;
  try {
    // Originals are immutable and never deleted. Dump first, then copy files:
    // any file referenced by this DB snapshot already exists in the store.
    const dump = await docker([
      "compose",
      "--env-file",
      ".env.local",
      "exec",
      "-T",
      "db",
      "pg_dump",
      ...dbArgs(databaseUrl),
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      "--exclude-schema=pgboss",
    ]);
    await writeFile(path.join(temporary, "database.dump"), dump, {
      mode: 0o600,
    });
    await copyDocuments(dataDir, path.join(temporary, "documents"));
    await writeFile(
      path.join(temporary, "manifest.json"),
      JSON.stringify({ version: 1, createdAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
    await exec("tar", [
      "-czf",
      path.join(temporary, "archive.tar.gz"),
      "-C",
      temporary,
      "manifest.json",
      "database.dump",
      "documents",
    ]);
    await mkdir(path.dirname(path.resolve(output)), {
      recursive: true,
      mode: 0o700,
    });
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
    await writeFile(partial, Buffer.concat([magic, iv]), { mode: 0o600 });
    await pipeline(
      createReadStream(path.join(temporary, "archive.tar.gz")),
      cipher,
      createWriteStream(partial, { flags: "a", mode: 0o600 }),
    );
    const handle = await open(partial, "a");
    try {
      await handle.write(cipher.getAuthTag());
      await handle.sync();
    } finally {
      await handle.close();
    }
    const { rename } = await import("node:fs/promises");
    await rename(partial, output);
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await rm(partial, { force: true });
  }
}
export async function restoreBackup(
  databaseUrl: string,
  dataDir: string,
  key: string,
  input: string,
) {
  const temporary = await mkdtemp(path.join(tmpdir(), "expenses-restore-"));
  try {
    const handle = await open(input, "r");
    let size: number, prefix: Buffer, tag: Buffer;
    try {
      size = (await handle.stat()).size;
      prefix = Buffer.alloc(magic.length + 12);
      tag = Buffer.alloc(16);
      await handle.read(prefix, 0, prefix.length, 0);
      await handle.read(tag, 0, 16, size - 16);
    } finally {
      await handle.close();
    }
    if (
      size < magic.length + 28 ||
      !prefix.subarray(0, magic.length).equals(magic)
    )
      throw new Error("Not an Expenses backup.");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key, "hex"),
      prefix.subarray(magic.length),
    );
    decipher.setAuthTag(tag);
    const archive = path.join(temporary, "archive.tar.gz");
    // Authentication must succeed before touching the target database/files.
    await pipeline(
      createReadStream(input, { start: prefix.length, end: size - 17 }),
      decipher,
      createWriteStream(archive, { mode: 0o600 }),
    );
    const listing = (await exec("tar", ["-tzf", archive])).stdout
      .trim()
      .split("\n");
    if (
      listing.some(
        (entry) =>
          !/^(?:manifest\.json|database\.dump|documents\/?|documents\/(?:receipts|emails)\/?|documents\/(?:receipts|emails)\/[a-f0-9]{64}\.[a-z]+)$/.test(
            entry,
          ),
      )
    )
      throw new Error("Backup contains unexpected files.");
    await exec("tar", ["-xzf", archive, "-C", temporary]);
    if (
      JSON.parse(await readFile(path.join(temporary, "manifest.json"), "utf8"))
        .version !== 1
    )
      throw new Error("Unsupported backup version.");
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
    } finally {
      await client.end();
    }
    await docker(
      [
        "compose",
        "--env-file",
        ".env.local",
        "exec",
        "-T",
        "db",
        "pg_restore",
        ...dbArgs(databaseUrl),
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        "--single-transaction",
      ],
      await readFile(path.join(temporary, "database.dump")),
    );
    await copyDocuments(path.join(temporary, "documents"), dataDir);
    const sessions = new pg.Client({ connectionString: databaseUrl });
    await sessions.connect();
    try {
      await sessions.query(
        "DELETE FROM web_sessions; DELETE FROM bank_states; DELETE FROM auth_attempts",
      );
    } finally {
      await sessions.end();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
