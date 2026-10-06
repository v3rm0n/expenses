import { query, type DB, pool } from "./db";
import { validDate, parseMoney } from "../lib/money";
import { AppError } from "./errors";
import { transactionNeedsReview } from "./transaction-review";
import type {
  Contributions,
  MonthlyTotals,
  SpendingAnalysis,
} from "../lib/spending-analysis";

export function dateWindow(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw new AppError("Choose a valid month.");
  const from = validDate(`${month}-01`),
    start = new Date(`${from}T12:00:00Z`);
  const to = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1),
  )
    .toISOString()
    .slice(0, 10);
  return { from, to };
}
export function periodWindow(month: string, months: number) {
  if (!Number.isInteger(months) || months < 1 || months > 12)
    throw new AppError("Choose a period from 1 to 12 months.");
  const { from: endMonth, to } = dateWindow(month);
  const start = new Date(`${endMonth}T12:00:00Z`);
  start.setUTCMonth(start.getUTCMonth() - (months - 1));
  return { from: start.toISOString().slice(0, 10), to };
}
export async function overview(month: string, currency: string, months = 1) {
  const { from, to } = periodWindow(month, months);
  const [totals] = await query<{
    transactions: number;
    gross_spending: number;
    refunds: number;
    income: number;
    expense_count: number;
    receipt_count: number;
    receipt_required_count: number;
    receipt_excluded_count: number;
  }>(
    `SELECT count(*)::int AS transactions,
    coalesce(sum(-amount) FILTER(WHERE kind='expense'),0)::bigint AS gross_spending,
    coalesce(sum(amount) FILTER(WHERE kind='refund'),0)::bigint AS refunds,
    coalesce(sum(amount) FILTER(WHERE kind='income'),0)::bigint AS income,
    count(*) FILTER(WHERE kind IN ('expense','refund'))::int AS expense_count,
    count(*) FILTER(WHERE kind IN ('expense','refund') AND NOT receipt_not_required)::int AS receipt_required_count,
    count(*) FILTER(WHERE kind IN ('expense','refund') AND receipt_not_required)::int AS receipt_excluded_count,
    count(*) FILTER(WHERE kind IN ('expense','refund') AND NOT receipt_not_required AND EXISTS(SELECT 1 FROM receipt_payments p WHERE p.transaction_id=t.id))::int AS receipt_count
    FROM ledger_transactions t WHERE status='BOOK' AND currency=$1 AND booked_at >= $2 AND booked_at < $3`,
    [currency, from, to],
  );
  const { investment, pension } = await contributionTotals(currency, from, to);
  const [uncategorized] = await query(
    `SELECT coalesce(sum(a.amount),0)::bigint AS amount,count(distinct t.id)::int AS count
    FROM ledger_allocations a JOIN ledger_transactions t ON t.id=a.transaction_id WHERE a.category_id='uncategorized' AND t.status='BOOK' AND t.currency=$1 AND t.booked_at >= $2 AND t.booked_at < $3`,
    [currency, from, to],
  );
  const categories = await query(
    `SELECT c.*,sum(a.amount)::bigint AS amount,count(distinct t.id)::int AS count FROM ledger_allocations a
    JOIN ledger_transactions t ON t.id=a.transaction_id JOIN categories c ON c.id=a.category_id
    WHERE t.status='BOOK' AND t.kind IN ('expense','refund') AND t.currency=$1 AND t.booked_at >= $2 AND t.booked_at < $3 GROUP BY c.id ORDER BY amount DESC`,
    [currency, from, to],
  );
  const merchants = await query(
    `SELECT merchant_name(merchant) AS merchant,sum(-amount)::bigint AS amount,count(*)::int AS count FROM ledger_transactions
    WHERE status='BOOK' AND kind IN ('expense','refund') AND currency=$1 AND booked_at >= $2 AND booked_at < $3 GROUP BY merchant_name(merchant) ORDER BY amount DESC LIMIT 6`,
    [currency, from, to],
  );
  const trend = await monthlyTrend(month, currency, months);
  const recent = await transactionList(
    new URLSearchParams({
      from,
      to: new Date(new Date(`${to}T12:00:00Z`).getTime() - 86400000)
        .toISOString()
        .slice(0, 10),
      currency,
      limit: "6",
    }),
  );
  const [pending] = await query(
    "SELECT count(*)::int AS count,coalesce(sum(-amount) FILTER(WHERE amount<0),0)::bigint AS amount FROM transactions WHERE status='PDNG' AND currency=$1",
    [currency],
  );
  const [cash] = await query(
    `SELECT coalesce(sum(p.amount),0)::bigint AS amount FROM journal_postings p
    JOIN ledger_accounts a ON a.id=p.account_id WHERE a.code='cash:'||$1`,
    [currency],
  );
  return {
    month,
    currency,
    from,
    to,
    ...totals,
    spending: totals.gross_spending - totals.refunds,
    net_cash_flow:
      totals.income -
      totals.gross_spending +
      totals.refunds -
      investment.net -
      pension.net,
    investment,
    pension,
    uncategorized,
    categories,
    merchants,
    trend,
    recent: recent.rows,
    pending,
    cash,
  };
}
async function contributionTotals(currency: string, from: string, to: string) {
  const contributions = await query<
    Contributions & { kind: "investment" | "pension" }
  >(
    `SELECT k.kind,
      coalesce(sum(-t.amount) FILTER(WHERE t.amount<0 AND t.booked_at >= $2),0)::bigint AS contributed,
      coalesce(sum(t.amount) FILTER(WHERE t.amount>0 AND t.booked_at >= $2),0)::bigint AS withdrawn,
      coalesce(sum(-t.amount) FILTER(WHERE t.booked_at >= $2),0)::bigint AS net,
      coalesce(sum(-t.amount) FILTER(WHERE t.amount<0),0)::bigint AS history_contributed,
      coalesce(sum(t.amount) FILTER(WHERE t.amount>0),0)::bigint AS history_withdrawn,
      coalesce(sum(-t.amount),0)::bigint AS history_net
    FROM (VALUES ('investment'),('pension')) k(kind)
    LEFT JOIN ledger_transactions t ON t.kind=k.kind AND t.status='BOOK' AND t.currency=$1 AND t.booked_at < $3
    GROUP BY k.kind ORDER BY k.kind`,
    [currency, from, to],
  );
  return {
    investment: contributions.find((c) => c.kind === "investment")!,
    pension: contributions.find((c) => c.kind === "pension")!,
  };
}

async function monthlyTrend(month: string, currency: string, months = 6) {
  const { from, to } = periodWindow(month, months);
  return query<MonthlyTotals>(
    `WITH months AS (SELECT generate_series($2::date,$3::date-interval '1 month',interval '1 month')::date AS month)
    SELECT to_char(m.month,'YYYY-MM') AS month,coalesce(sum(-t.amount) FILTER(WHERE t.kind IN ('expense','refund')),0)::bigint AS spending,
    coalesce(sum(t.amount) FILTER(WHERE t.kind='income'),0)::bigint AS income,
    coalesce(sum(-t.amount) FILTER(WHERE t.kind='investment'),0)::bigint AS investment,
    coalesce(sum(-t.amount) FILTER(WHERE t.kind='pension'),0)::bigint AS pension FROM months m LEFT JOIN ledger_transactions t ON t.booked_at>=m.month AND t.booked_at<m.month+interval '1 month'
    AND t.currency=$1 AND t.status='BOOK' GROUP BY m.month ORDER BY m.month`,
    [currency, from, to],
  );
}

export async function spendingAnalysis(
  month: string,
  currency: string,
  periodMonths = 6,
): Promise<SpendingAnalysis> {
  const { from, to } = periodWindow(month, periodMonths);
  const [months, categories, merchants, contributions] = await Promise.all([
    monthlyTrend(month, currency, periodMonths),
    query<SpendingAnalysis["categories"][number]>(
      `SELECT to_char(t.booked_at,'YYYY-MM') AS month,c.id,c.name,c.color,sum(a.amount)::bigint AS amount
      FROM ledger_allocations a JOIN ledger_transactions t ON t.id=a.transaction_id JOIN categories c ON c.id=a.category_id
      WHERE t.status='BOOK' AND t.kind IN ('expense','refund') AND t.currency=$1 AND t.booked_at >= $2 AND t.booked_at < $3
      GROUP BY month,c.id ORDER BY month,c.name`,
      [currency, from, to],
    ),
    query<SpendingAnalysis["merchants"][number]>(
      `SELECT to_char(t.booked_at,'YYYY-MM') AS month,a.category_id,merchant_name(t.merchant) AS merchant,sum(a.amount)::bigint AS amount
      FROM ledger_allocations a JOIN ledger_transactions t ON t.id=a.transaction_id
      WHERE t.status='BOOK' AND t.kind IN ('expense','refund') AND t.currency=$1 AND t.booked_at >= $2 AND t.booked_at < $3
      GROUP BY month,a.category_id,merchant_name(t.merchant) ORDER BY month,merchant,a.category_id`,
      [currency, from, to],
    ),
    contributionTotals(currency, from, to),
  ]);
  return {
    month,
    currency,
    from,
    to,
    months,
    categories,
    merchants,
    ...contributions,
  };
}

export function transactionFilters(params: URLSearchParams) {
  const values: unknown[] = [],
    conditions: string[] = ["t.status<>'SUPERSEDED'"];
  const add = (condition: string, value: unknown) => {
    values.push(value);
    conditions.push(condition.replace(/\?/g, `$${values.length}`));
  };
  if (params.get("month")) {
    const { from, to } = dateWindow(params.get("month")!);
    add("(t.booked_at>=? OR t.status='PDNG' AND t.booked_at IS NULL)", from);
    add("(t.booked_at<? OR t.status='PDNG' AND t.booked_at IS NULL)", to);
  }
  if (params.get("from")) add("t.booked_at>=?", validDate(params.get("from")!));
  if (params.get("to")) add("t.booked_at<=?", validDate(params.get("to")!));
  if (params.get("currency"))
    add("t.currency=?", params.get("currency")!.toUpperCase());
  if (params.get("account")) add("t.account_id::text=?", params.get("account"));
  if (params.get("category"))
    add(
      "EXISTS(SELECT 1 FROM allocations ca WHERE ca.transaction_id=t.id AND ca.category_id=?)",
      params.get("category"),
    );
  if (params.get("kind")) add("t.kind=?", params.get("kind"));
  if (params.get("status")) add("t.status=?", params.get("status"));
  if (params.get("search"))
    add(
      "(t.merchant ILIKE ? OR merchant_name(t.merchant) ILIKE ? OR t.description ILIKE ? OR t.note ILIKE ?)",
      `%${params.get("search")!.slice(0, 200)}%`,
    );
  if (params.get("minimum"))
    add(
      "abs(t.amount)>=?",
      parseMoney(params.get("minimum")!, params.get("currency") || "EUR"),
    );
  if (params.get("maximum"))
    add(
      "abs(t.amount)<=?",
      parseMoney(params.get("maximum")!, params.get("currency") || "EUR"),
    );
  if (params.get("receipt") === "missing")
    conditions.push(
      "NOT EXISTS(SELECT 1 FROM receipt_payments rp WHERE rp.transaction_id=t.id) AND t.kind IN ('expense','refund') AND NOT t.receipt_not_required",
    );
  if (params.get("receipt") === "not_required")
    conditions.push(
      "t.receipt_not_required AND t.kind IN ('expense','refund')",
    );
  if (params.get("receipt") === "linked")
    conditions.push(
      "EXISTS(SELECT 1 FROM receipt_payments rp WHERE rp.transaction_id=t.id)",
    );
  if (params.get("review") === "true") conditions.push(transactionNeedsReview);
  return { where: conditions.join(" AND "), values };
}
export async function transactionList(params: URLSearchParams, db: DB = pool) {
  const { where, values } = transactionFilters(params);
  const [count] = await query(
    `SELECT count(*)::int AS count FROM transactions t WHERE ${where}`,
    values,
    db,
  );
  const limit = Math.min(100, Math.max(1, Number(params.get("limit")) || 50)),
    page = Math.max(1, Number(params.get("page")) || 1);
  const rows = await query(
    `SELECT t.id,t.account_id,t.amount,t.currency,t.kind,t.status,t.booked_at,t.merchant,merchant_name(t.merchant) AS merchant_group,t.description,t.manual,t.note,t.receipt_not_required,COALESCE(NULLIF(a.nickname,''),a.name) AS account_name,a.source,
    coalesce((SELECT jsonb_agg(jsonb_build_object('category_id',al.category_id,'name',c.name,'color',c.color,'amount',al.amount,'source',al.source)) FROM allocations al JOIN categories c ON c.id=al.category_id WHERE al.transaction_id=t.id),'[]') AS allocations,
    (SELECT count(*)::int FROM receipt_payments p WHERE p.transaction_id=t.id) AS receipt_count FROM transactions t JOIN accounts a ON a.id=t.account_id
    WHERE ${where} ORDER BY t.booked_at DESC,t.created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, (page - 1) * limit],
    db,
  );
  return { rows, count: count.count, page, limit };
}
const receiptColumns = `SELECT r.*,coalesce((SELECT sum(p.amount)::bigint FROM receipt_payments p WHERE p.receipt_id=r.id),0) AS linked_amount,
    (SELECT count(*)::int FROM receipt_items ri WHERE ri.receipt_id=r.id) AS item_count FROM receipts r`;
function receiptFilters(params: URLSearchParams) {
  const conditions = ["r.status<>'duplicate'"],
    values: unknown[] = [];
  if (params.get("review") === "true")
    conditions.push(
      "(r.status IN ('review','ready') OR r.status='matched' AND coalesce((SELECT sum(p.amount) FROM receipt_payments p WHERE p.receipt_id=r.id),0)<abs(r.total))",
    );
  if (params.get("retailer")) {
    values.push(params.get("retailer"));
    conditions.push("r.retailer=$1");
  }
  return { where: conditions.join(" AND "), values };
}
export async function receiptList(review = false) {
  const { where, values } = receiptFilters(
    new URLSearchParams(review ? { review: "true" } : {}),
  );
  return query(
    `${receiptColumns} WHERE ${where} ORDER BY r.created_at DESC,r.id DESC`,
    values,
  );
}
export async function receiptPage(params: URLSearchParams) {
  const { where, values } = receiptFilters(params);
  const limit = 50;
  const requestedPage = Math.max(
    1,
    Math.floor(Number(params.get("page")) || 1),
  );
  const [count] = await query(
    `SELECT count(*)::int AS count FROM receipts r WHERE ${where}`,
    values,
  );
  const page = Math.min(
    requestedPage,
    Math.max(1, Math.ceil(count.count / limit)),
  );
  const rows = await query(
    `${receiptColumns} WHERE ${where} ORDER BY r.created_at DESC,r.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, (page - 1) * limit],
  );
  return { rows, count: count.count, page, limit };
}
export async function receiptDetail(
  id: string,
  preferredTransactionId: string | null = null,
) {
  const [receipt] = await query("SELECT * FROM receipts WHERE id=$1", [id]);
  if (!receipt) throw new AppError("Receipt not found.", 404);
  const items = await query(
    "SELECT ri.*,c.name AS category_name FROM receipt_items ri JOIN categories c ON c.id=ri.category_id WHERE receipt_id=$1 ORDER BY position",
    [id],
  );
  const suggestedCategories = await query(
    `SELECT c.id,c.name,c.color FROM categories c
    LEFT JOIN (
      SELECT i.category_id,count(*) AS uses FROM receipt_items i
      JOIN receipts r ON r.id=i.receipt_id WHERE r.status<>'duplicate'
      GROUP BY i.category_id
    ) usage ON usage.category_id=c.id
    WHERE c.id NOT IN ('uncategorized','investments','pension')
    ORDER BY CASE WHEN c.id='groceries' THEN 0 ELSE 1 END,
      coalesce(usage.uses,0) DESC,
      CASE c.id WHEN 'household' THEN 0 WHEN 'health' THEN 1 WHEN 'restaurants' THEN 2 ELSE 3 END,c.name
    LIMIT 4`,
  );
  const links = await query(
    `SELECT p.*,t.merchant,t.booked_at,t.currency,t.amount AS transaction_amount,t.status,t.description,COALESCE(NULLIF(a.nickname,''),a.name) AS account_name,a.source FROM receipt_payments p JOIN transactions t ON t.id=p.transaction_id JOIN accounts a ON a.id=t.account_id WHERE p.receipt_id=$1`,
    [id],
  );
  const candidates =
    receipt.purchased_at && receipt.total
      ? await query(
          `SELECT t.id,t.merchant,t.description,t.status,t.booked_at,t.amount,t.currency,COALESCE(NULLIF(a.nickname,''),a.name) AS account_name,
    abs(t.amount)-coalesce((SELECT sum(p.amount)::bigint FROM receipt_payments p WHERE p.transaction_id=t.id),0) AS available_amount
    FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE t.status IN ('BOOK','PDNG') AND t.currency=$1 AND t.kind=$2
    AND coalesce(t.booked_at,t.value_at,t.created_at::date) BETWEEN $3::date-1 AND $3::date+7 AND NOT EXISTS(SELECT 1 FROM receipt_payments p WHERE p.receipt_id=$4 AND p.transaction_id=t.id)
    AND abs(t.amount)>coalesce((SELECT sum(p.amount)::bigint FROM receipt_payments p WHERE p.transaction_id=t.id),0)
    ORDER BY CASE WHEN t.id=$6::uuid THEN 0 ELSE 1 END,abs(abs(t.amount)-abs($5::bigint)),CASE WHEN t.status='BOOK' THEN 0 ELSE 1 END,t.booked_at,t.id LIMIT 30`,
          [
            receipt.currency,
            receipt.total > 0 ? "expense" : "refund",
            receipt.purchased_at,
            id,
            receipt.total,
            preferredTransactionId,
          ],
        )
      : [];
  return {
    ...receipt,
    items,
    links,
    suggested_categories: suggestedCategories,
    candidates: candidates.filter((c) => c.available_amount > 0),
  };
}
export async function applicationState() {
  const [owner] = await query("SELECT name FROM owner");
  const categories = await query(
    "SELECT * FROM categories ORDER BY CASE WHEN id='uncategorized' THEN 1 ELSE 0 END,name",
  );
  const accounts = await query(
    "SELECT a.*,b.bank_name,b.country FROM accounts a LEFT JOIN bank_connections b ON b.id=a.connection_id ORDER BY a.source,a.name,a.currency",
  );
  const currencies = await query(
    "SELECT DISTINCT currency FROM (SELECT currency FROM transactions UNION SELECT currency FROM accounts UNION SELECT currency FROM ledger_accounts UNION SELECT currency FROM receipts UNION SELECT 'EUR') x WHERE currency IS NOT NULL ORDER BY currency",
  );
  const [review] = await query(`SELECT
    (SELECT count(*)::int FROM transactions t WHERE ${transactionNeedsReview}) AS transactions,
    (SELECT count(*)::int FROM receipts r WHERE status IN ('review','ready') OR status='matched' AND coalesce((SELECT sum(p.amount) FROM receipt_payments p WHERE p.receipt_id=r.id),0)<abs(r.total)) AS receipts,
    (SELECT count(*)::int FROM inbound_emails WHERE status IN ('review','error')) AS emails`);
  return {
    owner: owner.name,
    categories,
    accounts,
    currencies: currencies.map((c) => c.currency),
    review,
    appUrl: configUrl(),
  };
}
import { config } from "./config";
function configUrl() {
  return config.appUrl;
}
