import { normalize } from "../lib/classification";
import { query, type DB } from "./db";
import { transactionVisible } from "./account-visibility";

type MerchantEntry = {
  id: string;
  merchant: string;
  kind: string;
  currency: string;
};

// Learn only from owner decisions, never from our own inferred allocations.
// A split or conflicting correction makes a merchant unsuitable for inference.
export async function historicalMerchantCategory(entry: MerchantEntry, db: DB) {
  if (
    !entry.merchant.trim() ||
    normalize(entry.merchant) === "bank transaction" ||
    !["expense", "refund"].includes(entry.kind)
  )
    return;
  const rows = await query(
    `SELECT t.merchant,
      CASE WHEN count(a.category_id)=1 AND bool_and(a.source='manual')
        AND sum(a.amount)=-t.amount THEN min(a.category_id) END AS category_id
    FROM transactions t LEFT JOIN allocations a ON a.transaction_id=t.id
    WHERE t.id<>$1 AND t.kind=$2 AND t.currency=$3 AND t.manual
      AND t.status='BOOK' AND ${transactionVisible}
      AND NOT EXISTS(SELECT 1 FROM receipt_payments p WHERE p.transaction_id=t.id)
    GROUP BY t.id`,
    [entry.id, entry.kind, entry.currency],
    db,
  );
  const categories = new Set(
    rows
      .filter((row) => normalize(row.merchant) === normalize(entry.merchant))
      .map((row) => row.category_id),
  );
  if (categories.size !== 1) return;
  const category = [...categories][0] as string | null;
  if (
    category &&
    !["uncategorized", "investments", "pension"].includes(category)
  )
    return category;
}

// Only new imports inherit exemptions. An existing payment's flag, including
// an explicit "receipt required" correction, is never overwritten on reimport.
export async function inheritReceiptRequirement(entry: MerchantEntry, db: DB) {
  if (
    !entry.merchant.trim() ||
    normalize(entry.merchant) === "bank transaction" ||
    !["expense", "refund"].includes(entry.kind)
  )
    return;
  const rows = await query(
    `SELECT t.merchant,t.receipt_not_required AS value
    FROM transactions t
    WHERE t.id<>$1 AND t.kind=$2 AND t.currency=$3 AND t.status='BOOK'
      AND ${transactionVisible}
      AND EXISTS(SELECT 1 FROM corrections c WHERE c.entity='transaction' AND c.entity_id=t.id::text
        AND jsonb_typeof(c.change->'receiptNotRequired')='boolean'
        AND NOT (c.change ? 'inheritedFromMerchant'))`,
    [entry.id, entry.kind, entry.currency],
    db,
  );
  const choices = new Set(
    rows
      .filter((row) => normalize(row.merchant) === normalize(entry.merchant))
      .map((row) => row.value),
  );
  if (choices.size !== 1 || !choices.has(true)) return;
  await db.query(
    "UPDATE transactions SET receipt_not_required=true WHERE id=$1",
    [entry.id],
  );
  await db.query(
    "INSERT INTO corrections(entity,entity_id,change) VALUES('transaction',$1,$2)",
    [
      entry.id,
      JSON.stringify({
        receiptNotRequired: true,
        inheritedFromMerchant: normalize(entry.merchant),
      }),
    ],
  );
}
