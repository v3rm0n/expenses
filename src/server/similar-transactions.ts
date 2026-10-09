import { query, pool, type DB } from "./db";
import { matchesSimilarTransaction } from "../lib/similar-transactions";
import { normalize } from "../lib/classification";

export async function saveSimilarCategoryRule(
  entry: { merchant: string; kind: string; currency: string },
  pattern: string,
  categoryId: string,
  db: DB,
) {
  if (!entry.merchant.trim()) return;
  await db.query(
    `INSERT INTO similar_category_rules(merchant,pattern,kind,currency,category_id)
    VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(merchant,pattern,kind,currency) DO UPDATE
    SET category_id=excluded.category_id,updated_at=now()`,
    [
      normalize(entry.merchant),
      normalize(pattern),
      entry.kind,
      entry.currency,
      categoryId,
    ],
  );
}

export async function similarCategory(
  entry: {
    id: string;
    merchant: string;
    description: string;
    kind: string;
    currency: string;
  },
  db: DB,
): Promise<string | undefined> {
  if (!["expense", "refund"].includes(entry.kind) || !entry.merchant.trim())
    return;
  const rules = await query<{ pattern: string; category_id: string }>(
    `SELECT pattern,category_id FROM similar_category_rules
    WHERE merchant=$1 AND kind=$2 AND currency=$3
    AND NOT EXISTS(SELECT 1 FROM receipt_payments WHERE transaction_id=$4)
    ORDER BY updated_at DESC,pattern`,
    [normalize(entry.merchant), entry.kind, entry.currency, entry.id],
    db,
  );
  return rules.find((rule) =>
    matchesSimilarTransaction(entry, entry.merchant, rule.pattern),
  )?.category_id;
}

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
