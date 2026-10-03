import path from "node:path";
import { config, assertConfig } from "../src/server/config";
import { writeBackup } from "./archive";
assertConfig();
const output = path.resolve(
  process.argv[2] ||
    `backups/expenses-${new Date().toISOString().replace(/[:.]/g, "-")}.enc`,
);
await writeBackup(
  config.databaseUrl,
  config.dataDir,
  config.encryptionKey,
  output,
);
console.log(`Encrypted database and receipt backup saved: ${output}`);
