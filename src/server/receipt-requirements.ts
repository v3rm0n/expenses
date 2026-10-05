import { query, type DB } from "./db";
import { AppError } from "./errors";

// Call inside a transaction so flags and their audit records commit together.
export async function setReceiptRequirements(
  ids: string[],
  value: boolean,
  db: DB,
  context: Record<string, unknown> = {},
) {
  const unique = [...new Set(ids)];
  const rows = await query<{ id: string; receipt_not_required: boolean }>(
    "SELECT id,receipt_not_required FROM transactions WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
    [unique],
    db,
  );
  if (rows.length !== unique.length)
    throw new AppError("Transaction not found. No payments were updated.", 404);
  const changed = rows.filter((row) => row.receipt_not_required !== value);
  if (!changed.length) return 0;
  await db.query(
    "UPDATE transactions SET receipt_not_required=$2,updated_at=now() WHERE id=ANY($1::uuid[])",
    [changed.map((row) => row.id), value],
  );
  for (const row of changed)
    await db.query(
      "INSERT INTO corrections(entity,entity_id,change) VALUES('transaction',$1,$2)",
      [
        row.id,
        JSON.stringify({
          ...context,
          receiptNotRequired: value,
          previousReceiptNotRequired: row.receipt_not_required,
        }),
      ],
    );
  return changed.length;
}
