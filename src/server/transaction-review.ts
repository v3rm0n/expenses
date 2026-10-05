import { query, pool, type DB } from "./db";
import { validDate } from "../lib/money";
import { AppError } from "./errors";

export const transactionNeedsReview = `t.status='BOOK' AND t.kind IN ('expense','refund') AND (
  NOT EXISTS(SELECT 1 FROM allocations a WHERE a.transaction_id=t.id)
  OR EXISTS(SELECT 1 FROM allocations a WHERE a.transaction_id=t.id AND a.category_id='uncategorized' AND a.amount<>0)
  OR (NOT t.receipt_not_required AND (
    coalesce((SELECT sum(p.amount) FROM receipt_payments p WHERE p.transaction_id=t.id),0) < abs(t.amount)
    OR EXISTS(SELECT 1 FROM receipt_payments p JOIN receipts r ON r.id=p.receipt_id WHERE p.transaction_id=t.id AND r.status NOT IN ('ready','matched'))
  ))
)`;

export async function transactionReviewQueue(
  params: URLSearchParams,
  db: DB = pool,
) {
  let from: string, to: string;
  try {
    from = validDate(params.get("from") || "");
    to = validDate(params.get("to") || "");
  } catch {
    throw new AppError("Choose valid start and end dates.");
  }
  if (from > to)
    throw new AppError("The start date must be before the end date.");
  const currency = params.get("currency") || "";
  if (currency && !/^[A-Z]{3}$/.test(currency))
    throw new AppError("Choose a valid currency.");
  // Only IDs are loaded up front; transaction details load one at a time.
  // The queue covers the whole period rather than stopping at a table page.
  const rows = await query<{ id: string }>(
    `SELECT t.id FROM transactions t WHERE ${transactionNeedsReview}
    AND t.booked_at >= $1 AND t.booked_at <= $2 ${currency ? "AND t.currency=$3" : ""}
    ORDER BY t.booked_at,t.created_at,t.id`,
    [from, to, ...(currency ? [currency] : [])],
    db,
  );
  return { ids: rows.map((row) => row.id) };
}
