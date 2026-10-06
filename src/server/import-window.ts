import { query, pool, transaction, type DB } from "./db";
import { validDate } from "../lib/money";
import { AppError } from "./errors";
import { applyAllocations } from "./ledger";

export const DEFAULT_IMPORT_START_DATE = "2026-01-01";
const windowLock = 4317005;

export async function importStartDate(db: DB = pool) {
  const [setting] = await query(
    "SELECT value FROM settings WHERE key='import_start_date'",
    [],
    db,
  );
  return validDate(setting?.value || DEFAULT_IMPORT_START_DATE);
}

// Imports hold a shared transaction lock, so changing the date and pruning
// records cannot race an import that read the previous setting.
export async function lockImportWindow(db: DB, exclusive = false) {
  await db.query(
    exclusive
      ? "SELECT pg_advisory_xact_lock($1)"
      : "SELECT pg_advisory_xact_lock_shared($1)",
    [windowLock],
  );
  return importStartDate(db);
}

export async function requireImportDate(date: string, db: DB) {
  const start = await lockImportWindow(db);
  if (validDate(date) < start)
    throw new AppError(
      `Choose a date on or after ${start}, the import start date in Settings.`,
    );
}

export async function removeReceipts(ids: string[], db: DB) {
  if (!ids.length) return 0;
  // Duplicate documents belong to the same purchase, including ones that
  // have not yet had their own purchase date populated.
  const discarded = await query<{ id: string }>(
    `WITH RECURSIVE discarded AS (
      SELECT id FROM receipts WHERE id=ANY($1::uuid[])
      UNION SELECT r.id FROM receipts r JOIN discarded d ON r.duplicate_of=d.id
    ) SELECT id FROM discarded`,
    [ids],
    db,
  );
  const receiptIds = discarded.map((row) => row.id);
  const affected = await query<{ transaction_id: string }>(
    "SELECT DISTINCT transaction_id FROM receipt_payments WHERE receipt_id=ANY($1::uuid[]) ORDER BY transaction_id",
    [receiptIds],
    db,
  );
  await db.query(
    "DELETE FROM retailer_receipts WHERE receipt_id=ANY($1::uuid[])",
    [receiptIds],
  );
  await db.query(
    `UPDATE inbound_emails SET receipt_ids=(
      SELECT coalesce(jsonb_agg(entry.value ORDER BY entry.position),'[]'::jsonb)
      FROM jsonb_array_elements_text(receipt_ids) WITH ORDINALITY entry(value,position)
      WHERE NOT (entry.value=ANY($1::text[]))
    ) WHERE receipt_ids ?| $1::text[]`,
    [receiptIds],
  );
  await db.query(
    "DELETE FROM corrections WHERE entity='receipt' AND entity_id=ANY($1::text[])",
    [receiptIds],
  );
  const removed = await query(
    "DELETE FROM receipts WHERE id=ANY($1::uuid[]) RETURNING id",
    [receiptIds],
    db,
  );
  for (const row of affected) await applyAllocations(row.transaction_id, db);
  return removed.length;
}

export async function saveImportStartDate(date: string) {
  const start = validDate(date);
  return transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock($1)", [windowLock]);
    const previous = await importStartDate(db);
    await db.query(
      "INSERT INTO settings(key,value) VALUES('import_start_date',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()",
      [JSON.stringify(start)],
    );
    const olderReceipts = await query<{ id: string }>(
      "SELECT id FROM receipts WHERE purchased_at<$1",
      [start],
      db,
    );
    const receipts = await removeReceipts(
      olderReceipts.map((row) => row.id),
      db,
    );
    const affected = await query<{ receipt_id: string }>(
      "SELECT DISTINCT p.receipt_id FROM receipt_payments p JOIN transactions t ON t.id=p.transaction_id WHERE coalesce(t.booked_at,t.value_at)<$1",
      [start],
      db,
    );
    await db.query(
      "DELETE FROM corrections WHERE entity='transaction' AND entity_id IN (SELECT id::text FROM transactions WHERE coalesce(booked_at,value_at)<$1)",
      [start],
    );
    const removed = await query(
      "DELETE FROM transactions WHERE coalesce(booked_at,value_at)<$1 RETURNING id",
      [start],
      db,
    );
    for (const row of affected)
      await db.query(
        "UPDATE receipts SET status=CASE WHEN EXISTS(SELECT 1 FROM receipt_payments WHERE receipt_id=$1) THEN 'matched' WHEN status='matched' THEN 'ready' ELSE status END,updated_at=now() WHERE id=$1",
        [row.receipt_id],
      );
    await db.query(
      `UPDATE accounts a SET history_from=(SELECT min(booked_at) FROM transactions WHERE account_id=a.id),
        history_to=(SELECT max(booked_at) FROM transactions WHERE account_id=a.id) WHERE source='bank'`,
    );
    if (start < previous)
      await db.query(
        "UPDATE accounts SET last_sync_at=NULL WHERE source='bank'",
      );
    return {
      startDate: start,
      removedTransactions: removed.length,
      removedReceipts: receipts,
    };
  });
}
