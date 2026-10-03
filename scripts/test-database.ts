import dotenv from "dotenv";
import pg from "pg";
import { randomBytes } from "node:crypto";
dotenv.config({ path: ".env.local", quiet: true });
export async function isolatedDatabase(label: string) {
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const name = `expenses_test_${label}_${randomBytes(5).toString("hex")}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    name,
    async dispose() {
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}
