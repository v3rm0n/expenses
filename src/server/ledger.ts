import type { DB } from "./db";
import { query, pool } from "./db";
import {
  matchingRule,
  merchantCategory,
  transactionKind,
  contributionCategory,
  allocationAmount,
} from "../lib/classification";
import { prorate } from "../lib/money";
import type { Allocation, Rule } from "../lib/types";
import { AppError } from "./errors";

export async function applyAllocations(
  id: string,
  db: DB = pool,
  force = false,
) {
  const [entry] = await query(
    "SELECT * FROM transactions WHERE id=$1 FOR UPDATE",
    [id],
    db,
  );
  if (!entry || (entry.manual && !force)) return;
  const rules = await query<Rule>(
    "SELECT * FROM rules WHERE enabled ORDER BY priority,created_at",
    [],
    db,
  );
  const rule = matchingRule(rules, entry.merchant, entry.description);
  const ownTransfer =
    entry.counterparty_iban &&
    (
      await query(
        "SELECT 1 FROM accounts WHERE upper(regexp_replace(iban,'\\s','','g'))=upper(regexp_replace($1::text,'\\s','','g')) LIMIT 1",
        [entry.counterparty_iban],
        db,
      )
    ).length > 0;
  let kind = transactionKind(
    entry.amount < 0 ? "DBIT" : "CRDT",
    `${entry.merchant} ${entry.description}`,
    Boolean(ownTransfer),
    entry.raw?.bank_transaction_code?.code,
  );
  const ruleKind =
    rule?.category_id === "investments"
      ? "investment"
      : rule?.category_id === "pension"
        ? "pension"
        : null;
  if (entry.amount < 0 && ruleKind) kind = ruleKind;
  else if (rule && !ruleKind && contributionCategory(kind)) kind = "expense";
  // A receipt-linked payment remains a purchase until its receipts are unlinked.
  if (
    contributionCategory(kind) &&
    (
      await query(
        "SELECT 1 FROM receipt_payments WHERE transaction_id=$1",
        [id],
        db,
      )
    ).length
  )
    kind = entry.amount < 0 ? "expense" : "refund";
  if (kind !== entry.kind)
    await db.query(
      "UPDATE transactions SET kind=$2,updated_at=now() WHERE id=$1",
      [id, kind],
    );
  const amount = allocationAmount(kind, entry.amount);
  const capitalCategory = contributionCategory(kind);
  let allocations: Allocation[] = [];
  if (amount && capitalCategory) {
    allocations = [
      {
        categoryId: capitalCategory,
        amount,
        source: ruleKind ? "rule" : "merchant",
      },
    ];
  } else if (amount) {
    if (rule && !ruleKind)
      allocations = [{ categoryId: rule.category_id, amount, source: "rule" }];
    else {
      const links = await query(
        `SELECT p.*,r.total,r.status FROM receipt_payments p JOIN receipts r ON r.id=p.receipt_id WHERE transaction_id=$1 ORDER BY p.created_at`,
        [id],
        db,
      );
      let allocated = 0;
      for (const link of links) {
        if (!["ready", "matched"].includes(link.status)) continue;
        const items = await query(
          "SELECT * FROM receipt_items WHERE receipt_id=$1 ORDER BY position",
          [link.receipt_id],
          db,
        );
        if (
          !items.length ||
          items.reduce((sum, item) => sum + item.amount, 0) !== link.total
        )
          continue;
        const signed = Math.sign(amount) * link.amount;
        const shares = prorate(
          items.map((item) => item.amount),
          signed,
        );
        allocations.push(
          ...items.map((item, i) => ({
            categoryId: item.category_id,
            amount: shares[i],
            source: "receipt",
          })),
        );
        allocated += signed;
      }
      const remainder = amount - allocated;
      if (remainder)
        allocations.push({
          categoryId: merchantCategory(
            entry.merchant,
            entry.description,
            entry.mcc,
          ),
          amount: remainder,
          source: "merchant",
        });
    }
  }
  await replaceAllocations(id, allocations, amount, db);
}
export async function replaceAllocations(
  id: string,
  allocations: Allocation[],
  expected: number,
  db: DB,
) {
  if (
    allocations.reduce((sum, allocation) => sum + allocation.amount, 0) !==
    expected
  )
    throw new AppError("Category allocations must equal the expense amount.");
  const merged = new Map<string, Allocation>();
  for (const allocation of allocations) {
    const current = merged.get(allocation.categoryId);
    merged.set(allocation.categoryId, {
      ...allocation,
      amount: (current?.amount || 0) + allocation.amount,
      source:
        current && current.source !== allocation.source
          ? "mixed"
          : allocation.source,
    });
  }
  await db.query("DELETE FROM allocations WHERE transaction_id=$1", [id]);
  for (const allocation of merged.values())
    if (allocation.amount)
      await db.query(
        "INSERT INTO allocations(transaction_id,category_id,amount,source) VALUES($1,$2,$3,$4)",
        [id, allocation.categoryId, allocation.amount, allocation.source],
      );
}
export async function autoMatchReceipt(receiptId: string, db: DB = pool) {
  const [receipt] = await query(
    "SELECT * FROM receipts WHERE id=$1 FOR UPDATE",
    [receiptId],
    db,
  );
  if (
    !receipt ||
    receipt.status !== "ready" ||
    !receipt.total ||
    !receipt.purchased_at
  )
    return;
  if (receipt.retailer === "wolt") {
    // Wolt issues separate food and delivery invoices with the same order ID.
    // Match the complete group, never an unverified single subtotal.
    if (receipt.order_id) await autoMatchWoltOrder(receipt.order_id, db);
    return;
  }
  if (receipt.retailer === "amazon" && receipt.order_id) {
    await autoMatchAmazonOrder(receipt.order_id, db);
    return;
  }
  if (
    (
      await query(
        "SELECT 1 FROM receipt_payments WHERE receipt_id=$1",
        [receiptId],
        db,
      )
    ).length
  )
    return;
  const merchant =
    receipt.retailer === "partnerkaart"
      ? receipt.merchant?.split(" ")[0]
      : receipt.retailer;
  if (!merchant || merchant === "unknown") return;
  const candidates = await query(
    `SELECT t.* FROM transactions t WHERE t.status='BOOK' AND t.currency=$1 AND t.amount=$2
    AND t.kind=$3 AND t.booked_at BETWEEN $4::date-1 AND $4::date+7 AND t.merchant ILIKE ANY($5::text[])
    AND NOT EXISTS(SELECT 1 FROM receipt_payments p WHERE p.transaction_id=t.id)`,
    [
      receipt.currency,
      -receipt.total,
      receipt.total > 0 ? "expense" : "refund",
      receipt.purchased_at,
      receipt.retailer === "amazon"
        ? ["%amazon%", "%amzn%"]
        : receipt.retailer === "coop"
          ? ["%coop%", "%konsum%", "%maksimarket%"]
          : [`%${merchant}%`],
    ],
    db,
  );
  if (candidates.length === 1)
    await linkReceipt(
      receiptId,
      candidates[0].id,
      Math.abs(receipt.total),
      true,
      db,
    );
}
async function autoMatchAmazonOrder(orderId: string, db: DB) {
  const receipts = await query(
    "SELECT r.* FROM receipts r WHERE retailer='amazon' AND order_id=$1 AND duplicate_of IS NULL ORDER BY id FOR UPDATE",
    [orderId],
    db,
  );
  const first = receipts[0];
  if (!first) return;
  const candidates = (
    amount: number,
    date: string,
    currency: string,
    through = date,
  ) =>
    query(
      `SELECT t.id FROM transactions t WHERE t.status='BOOK' AND t.currency=$1 AND t.amount=$2 AND t.kind=$3
    AND t.booked_at BETWEEN $4::date-1 AND $5::date+7 AND t.merchant ILIKE ANY(ARRAY['%amazon%','%amzn%'])
    AND NOT EXISTS(SELECT 1 FROM receipt_payments p WHERE p.transaction_id=t.id)`,
      [currency, -amount, amount > 0 ? "expense" : "refund", date, through],
      db,
    );
  const linked = await query(
    "SELECT receipt_id FROM receipt_payments WHERE receipt_id=ANY($1::uuid[])",
    [receipts.map((r) => r.id)],
    db,
  );
  const count = Math.max(...receipts.map((r) => r.order_document_count || 0));
  if (
    count > 1 &&
    receipts.length === count &&
    !linked.length &&
    receipts.every(
      (r) =>
        r.status === "ready" &&
        r.purchased_at &&
        r.currency === first.currency &&
        Math.sign(r.total) === Math.sign(first.total) &&
        r.total !== 0,
    )
  ) {
    const total = receipts.reduce((sum, r) => sum + r.total, 0);
    const dates = receipts.map((r) => r.purchased_at).sort();
    // A combined charge must fall inside every invoice's matching window.
    const matches = await candidates(
      total,
      dates.at(-1)!,
      first.currency,
      dates[0],
    );
    if (matches.length === 1) {
      for (const receipt of receipts)
        await linkReceipt(
          receipt.id,
          matches[0].id,
          Math.abs(receipt.total),
          true,
          db,
        );
      return;
    }
  }
  for (const receipt of receipts) {
    if (
      receipt.status !== "ready" ||
      !receipt.total ||
      !receipt.purchased_at ||
      linked.some((link) => link.receipt_id === receipt.id)
    )
      continue;
    const matches = await candidates(
      receipt.total,
      receipt.purchased_at,
      receipt.currency,
    );
    if (matches.length === 1)
      await linkReceipt(
        receipt.id,
        matches[0].id,
        Math.abs(receipt.total),
        true,
        db,
      );
  }
}
async function autoMatchWoltOrder(orderId: string, db: DB) {
  const receipts = await query(
    "SELECT * FROM receipts WHERE retailer='wolt' AND order_id=$1 AND duplicate_of IS NULL ORDER BY id FOR UPDATE",
    [orderId],
    db,
  );
  const first = receipts[0];
  const knownTotals = receipts
    .map((receipt) => receipt.order_total)
    .filter((total) => total !== null);
  const total = receipts.reduce((sum, receipt) => sum + receipt.total, 0);
  if (
    !first ||
    (!knownTotals.length && receipts.length < 2) ||
    knownTotals.some((knownTotal) => knownTotal !== total) ||
    !first.purchased_at ||
    receipts.some(
      (receipt) =>
        receipt.status !== "ready" ||
        (receipt.order_currency !== null &&
          receipt.order_currency !== first.currency) ||
        receipt.currency !== first.currency ||
        receipt.purchased_at !== first.purchased_at ||
        receipt.total <= 0 ||
        receipt.card_amount !== receipt.total ||
        (receipt.cash_amount || 0) !== 0,
    )
  )
    return;
  if (
    (
      await query(
        "SELECT 1 FROM receipt_payments WHERE receipt_id=ANY($1::uuid[])",
        [receipts.map((receipt) => receipt.id)],
        db,
      )
    ).length
  )
    return;
  const candidates = await query(
    `SELECT t.id FROM transactions t WHERE t.status='BOOK' AND t.currency=$1 AND t.amount=$2 AND t.kind='expense'
    AND t.booked_at BETWEEN $3::date-1 AND $3::date+7 AND t.merchant ILIKE '%wolt%'
    AND NOT EXISTS(SELECT 1 FROM receipt_payments p WHERE p.transaction_id=t.id)`,
    [first.currency, -total, first.purchased_at],
    db,
  );
  if (candidates.length === 1)
    for (const receipt of receipts)
      await linkReceipt(receipt.id, candidates[0].id, receipt.total, true, db);
}
export async function linkReceipt(
  receiptId: string,
  transactionId: string,
  amount: number,
  automatic: boolean,
  db: DB,
) {
  const [receipt] = await query(
    "SELECT * FROM receipts WHERE id=$1 FOR UPDATE",
    [receiptId],
    db,
  );
  const [entry] = await query(
    "SELECT * FROM transactions WHERE id=$1 FOR UPDATE",
    [transactionId],
    db,
  );
  if (!receipt || !entry)
    throw new AppError("Receipt or transaction was not found.", 404);
  if (!["ready", "matched"].includes(receipt.status) || !receipt.total)
    throw new AppError(
      "Validate the receipt amounts before linking a payment.",
    );
  if (
    !["BOOK", "PDNG"].includes(entry.status) ||
    (automatic && entry.status !== "BOOK") ||
    receipt.currency !== entry.currency ||
    entry.kind !== (receipt.total > 0 ? "expense" : "refund")
  )
    throw new AppError(
      "Choose a booked or pending expense or refund with the same currency and direction.",
    );
  const [receiptPaid] = await query(
    "SELECT coalesce(sum(amount),0)::bigint AS amount FROM receipt_payments WHERE receipt_id=$1 AND transaction_id<>$2",
    [receiptId, transactionId],
    db,
  );
  const [entryPaid] = await query(
    "SELECT coalesce(sum(amount),0)::bigint AS amount FROM receipt_payments WHERE transaction_id=$1 AND receipt_id<>$2",
    [transactionId, receiptId],
    db,
  );
  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    amount + receiptPaid.amount > Math.abs(receipt.total) ||
    amount + entryPaid.amount > Math.abs(entry.amount)
  )
    throw new AppError(
      "Linked amounts cannot exceed the receipt or payment total.",
    );
  await db.query(
    "INSERT INTO receipt_payments(receipt_id,transaction_id,amount,automatic) VALUES($1,$2,$3,$4) ON CONFLICT(receipt_id,transaction_id) DO UPDATE SET amount=excluded.amount,automatic=excluded.automatic",
    [receiptId, transactionId, amount, automatic],
  );
  await db.query(
    "UPDATE receipts SET status='matched',updated_at=now() WHERE id=$1",
    [receiptId],
  );
  await applyAllocations(transactionId, db);
}
export async function reclassify(db: DB = pool) {
  const entries = await query(
    "SELECT id FROM transactions WHERE NOT manual",
    [],
    db,
  );
  for (const entry of entries) await applyAllocations(entry.id, db);
  return entries.length;
}
