import { config, assertConfig } from "../src/server/config";
import { restoreBackup } from "./archive";
assertConfig();
if (process.argv.length !== 4 || process.argv[3] !== "--confirm-replace")
  throw new Error(
    "Stop the app and worker, then run: npm run restore -- /path/to/backup.enc --confirm-replace. This replaces the configured database.",
  );
await restoreBackup(
  config.databaseUrl,
  config.dataDir,
  config.encryptionKey,
  process.argv[2],
);
console.log(
  "Database and original documents restored. Restart the app; sign in again.",
);
