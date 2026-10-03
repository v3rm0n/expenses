import "../src/server/config";
import { docker } from "./docker";
await docker(["compose", "--env-file", ".env.local", "up", "-d", "db"]);
console.log("Database started on 127.0.0.1:54329.");
