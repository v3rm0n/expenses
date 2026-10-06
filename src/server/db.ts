import pg, { type PoolClient, type QueryResultRow } from "pg";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { CATEGORY_SEEDS } from "../lib/types";
const globalDb = globalThis as unknown as {
  expensePool?: pg.Pool;
  expenseMigration?: Promise<void>;
};
pg.types.setTypeParser(1082, (value) => value);
pg.types.setTypeParser(20, (value) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new Error("Database amount exceeds safe integer range");
  return number;
});
export const pool =
  globalDb.expensePool ||
  new pg.Pool({ connectionString: config.databaseUrl, max: 8 });
globalDb.expensePool = pool;
pool.on("error", () => console.error("A database connection was interrupted."));
export type DB = pg.Pool | PoolClient;
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  values: unknown[] = [],
  db: DB = pool,
): Promise<T[]> {
  return (await db.query<T>(sql, values)).rows;
}
export async function transaction<T>(
  fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
export async function migrate() {
  if (!globalDb.expenseMigration)
    globalDb.expenseMigration = transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(4317001)");
      const sql = await readFile(
        path.resolve("migrations/001-initial.sql"),
        "utf8",
      );
      await db.query(sql);
      if (
        !(await db.query("SELECT 1 FROM schema_migrations WHERE version=2"))
          .rowCount
      ) {
        await db.query(
          await readFile(
            path.resolve("migrations/002-merchant-aliases.sql"),
            "utf8",
          ),
        );
      }
      for (const [id, name, color] of CATEGORY_SEEDS)
        await db.query(
          "INSERT INTO categories(id,name,color) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [id, name, color],
        );
      if (
        !(await db.query("SELECT 1 FROM schema_migrations WHERE version=3"))
          .rowCount
      ) {
        await db.query(
          await readFile(
            path.resolve("migrations/003-double-entry.sql"),
            "utf8",
          ),
        );
      }
    }).catch((error) => {
      globalDb.expenseMigration = undefined;
      throw error;
    });
  await globalDb.expenseMigration;
}
