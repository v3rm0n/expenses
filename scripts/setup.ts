import { config, assertConfig } from "../src/server/config";
import { migrate, pool, query } from "../src/server/db";
assertConfig();
await migrate();
if ((await query("SELECT 1 FROM owner")).length)
  console.log(`The owner is configured. Sign in at ${config.accessUrl}`);
else
  console.log(
    `Create your owner account using this one-time setup link:\n${config.accessUrl}/setup?token=${encodeURIComponent(config.setupToken)}`,
  );
await pool.end();
