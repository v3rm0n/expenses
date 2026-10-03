import { assertConfig } from "../src/server/config";
import { migrate, pool } from "../src/server/db";
assertConfig();
await migrate();
console.log("Database migrations applied.");
await pool.end();
