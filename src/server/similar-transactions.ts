import { query, pool, type DB } from "./db";
import { matchesSimilarTransaction } from "../lib/similar-transactions";

export type SimilarTransaction = {
  id: string;
  merchant: string;
  description: string;
  kind: string;
  currency: string;
  amount: number;
  booked_at: string;
  note: string;
  manual: boolean;
  receipt_not_required: boolean;
};

export async function similarTransactions(
  entry: { id: string; merchant: string; kind: string; currency: string },
  pattern: string,
  db: DB = pool,
  lock = false,
  includeManual = false,
): Promise<SimilarTransaction[]> {
  if (!["expense", "refund"].includes(entry.kind) || !entry.merchant.trim())
    return [];
  // Find candidates without locking unrelated merchants, then recheck eligibility
  // after acquiring locks so concurrent corrections are preserved.
  const candidates = lock
    ? await similarTransactions(entry, pattern, db, false, includeManual)
    : null;
  if (candidates && !candidates.length) return [];
  const rows = await query<SimilarTransaction>(
    `SELECT t.* FROM transactions t WHERE t.id<>$1 AND t.kind=$2 AND t.currency=$3
    AND t.status IN ('BOOK','PDNG') ${includeManual ? "" : "AND NOT t.manual"}
    ${candidates ? "AND t.id=ANY($4::uuid[])" : ""}
    AND NOT EXISTS(SELECT 1 FROM receipt_payments p WHERE p.transaction_id=t.id)
    ORDER BY t.id ${lock ? "FOR UPDATE OF t" : ""}`,
    [
      entry.id,
      entry.kind,
      entry.currency,
      ...(candidates ? [candidates.map((row) => row.id)] : []),
    ],
    db,
  );
  return rows.filter((row) =>
    matchesSimilarTransaction(row, entry.merchant, pattern),
  );
}
