import { query, pool } from "./db";
import { decrypt, encrypt, digest } from "./crypto";
import { AppError } from "./errors";
import { storeReceipt } from "./receipts";
import { importLidlHistory, openLidl, type LidlOptions } from "./lidl-client";

export async function lidlStatus() {
  const [row] = await query("SELECT value FROM settings WHERE key='lidl'");
  if (!row?.value?.cipher) return null;
  const options = decrypt<LidlOptions>(row.value.cipher);
  return {
    user: options.user,
    enabled: options.enabled,
    hasPassword: Boolean(options.password),
    lastSyncAt: row.value.lastSyncAt || null,
    error: row.value.error || null,
  };
}

export async function saveLidl(input: {
  user: string;
  password?: string;
  enabled: boolean;
}) {
  const [row] = await query("SELECT value FROM settings WHERE key='lidl'");
  const previous = row?.value?.cipher
    ? decrypt<LidlOptions>(row.value.cipher)
    : null;
  const unchanged = previous?.user === input.user;
  const password = input.password || (unchanged ? previous?.password : "");
  if (!password) throw new AppError("Enter the Lidl account password.");
  await query(
    "INSERT INTO settings(key,value) VALUES('lidl',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()",
    [
      JSON.stringify({
        ...(unchanged ? { lastSyncAt: row.value.lastSyncAt } : {}),
        cipher: encrypt({
          ...input,
          password,
          session: unchanged && !input.password ? previous?.session : undefined,
        }),
        error: null,
      }),
    ],
  );
}

export async function syncLidl(interactive = false) {
  // A session lock covers manual and scheduled jobs, including multiple workers.
  const db = await pool.connect();
  let client: Awaited<ReturnType<typeof openLidl>> | undefined;
  let runId: string | undefined;
  let cipher: string | undefined;
  let imported = 0;
  try {
    const [lock] = await query(
      "SELECT pg_try_advisory_lock(4317002) AS acquired",
      [],
      db,
    );
    if (!lock.acquired) return;
    const [row] = await query(
      "SELECT value FROM settings WHERE key='lidl'",
      [],
      db,
    );
    if (!row?.value?.cipher) return;
    cipher = row.value.cipher;
    const options = decrypt<LidlOptions>(cipher!);
    if (!options.enabled) return;
    const [run] = await query(
      "INSERT INTO import_runs(type) VALUES('lidl') RETURNING id",
      [],
      db,
    );
    runId = run.id;
    await query(
      "UPDATE settings SET value=value || $1::jsonb WHERE key='lidl' AND value->>'cipher'=$2",
      [JSON.stringify({ lastAttemptAt: new Date().toISOString() }), cipher],
      db,
    );
    client = await openLidl(options, interactive);
    const account = digest(options.user.toLowerCase());
    await importLidlHistory(
      client,
      async (id) =>
        Boolean(
          (
            await query(
              "SELECT 1 FROM retailer_receipts WHERE retailer='lidl' AND account_key=$1 AND external_id=$2",
              [account, id],
              db,
            )
          ).length,
        ),
      async (id, text) => {
        const [current] = await query(
          "SELECT value->>'cipher' AS cipher FROM settings WHERE key='lidl'",
          [],
          db,
        );
        if (current?.cipher !== cipher)
          throw new AppError(
            "The Lidl connection changed during import. Retry with the current settings.",
          );
        const result = await storeReceipt(
          Buffer.from(text),
          `lidl-${id}.txt`,
          "lidl",
          "lidl",
        );
        await query(
          "INSERT INTO retailer_receipts(retailer,account_key,external_id,receipt_id) VALUES('lidl',$1,$2,$3) ON CONFLICT DO NOTHING",
          [account, id, result.id],
          db,
        );
        if (!result.duplicate) imported++;
        await query(
          "UPDATE import_runs SET count=$2 WHERE id=$1",
          [runId, imported],
          db,
        );
      },
    );
    const session = await client.session();
    await query(
      "UPDATE settings SET value=value || $1::jsonb,updated_at=now() WHERE key='lidl' AND value->>'cipher'=$2",
      [
        JSON.stringify({
          cipher: encrypt({ ...options, session }),
          lastSyncAt: new Date().toISOString(),
          error: null,
        }),
        cipher,
      ],
      db,
    );
    await query(
      "UPDATE import_runs SET status='complete',count=$2,finished_at=now() WHERE id=$1",
      [runId, imported],
      db,
    );
  } catch (error) {
    const message =
      error instanceof AppError
        ? error.message
        : "Lidl import failed. Reconnect your account or retry; previously imported receipts are retained.";
    if (cipher)
      await query(
        "UPDATE settings SET value=value || $1::jsonb WHERE key='lidl' AND value->>'cipher'=$2",
        [JSON.stringify({ error: message }), cipher],
        db,
      );
    if (runId)
      await query(
        "UPDATE import_runs SET status='error',count=$2,error=$3,finished_at=now() WHERE id=$1",
        [runId, imported, message],
        db,
      );
    throw new AppError(message, 502);
  } finally {
    await client?.close().catch(() => {});
    await db.query("SELECT pg_advisory_unlock(4317002)").catch(() => {});
    db.release();
  }
}
