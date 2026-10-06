import { randomUUID } from "node:crypto";
import { query, transaction, type DB } from "./db";
import { AppError } from "./errors";
import { digest } from "./crypto";
import { parseMoney, validDate } from "../lib/money";
import type {
  AccountType,
  JournalInput,
  Journal,
  JournalPosting,
  LedgerRow,
  AccountingAccount,
} from "../lib/accounting";

const origin =
  "CASE WHEN j.transaction_id IS NOT NULL THEN 'transaction' WHEN j.opening_account_id IS NOT NULL THEN 'opening' ELSE 'manual' END";
const accountName = "coalesce(nullif(b.nickname,''),b.name,a.name)";
const journalColumns = `j.*,${origin} AS origin,
  (SELECT coalesce(sum(p.debit),0)::bigint FROM journal_postings p WHERE p.entry_id=j.id) AS debit,
  (SELECT coalesce(sum(p.credit),0)::bigint FROM journal_postings p WHERE p.entry_id=j.id) AS credit`;

function dates(from?: string, to?: string) {
  if (from) validDate(from);
  if (to) validDate(to);
  if (from && to && from > to)
    throw new AppError("Start date must be on or before end date.");
}

export async function journalDetail(id: string, db?: DB) {
  const read = async (connection: DB) => {
    const [journal] = await query<Journal>(
      `SELECT ${journalColumns} FROM journal_entries j WHERE j.id=$1`,
      [id],
      connection,
    );
    if (!journal) throw new AppError("Journal entry not found.", 404);
    const postings = await query<JournalPosting>(
      `SELECT p.*,a.code,${accountName} AS name,a.type FROM journal_postings p
       JOIN ledger_accounts a ON a.id=p.account_id LEFT JOIN accounts b ON b.id=a.source_account_id
       WHERE p.entry_id=$1 ORDER BY p.position,p.amount DESC,p.id`,
      [id],
      connection,
    );
    return { journal, postings };
  };
  if (db) return read(db);
  return transaction(async (connection) => {
    await connection.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    return read(connection);
  });
}

export async function journalPage(input: {
  currency: string;
  from?: string;
  to?: string;
  origin?: string;
  search?: string;
  page?: number;
}) {
  dates(input.from, input.to);
  const values = [
    input.currency,
    input.from || null,
    input.to || null,
    input.origin || "all",
    input.search?.trim() || "",
  ];
  const where = `j.currency=$1 AND ($2::date IS NULL OR j.booked_at>=$2) AND ($3::date IS NULL OR j.booked_at<=$3)
    AND ($4='all' OR ${origin}=$4)
    AND ($5='' OR j.description ILIKE '%'||$5||'%' OR j.reference ILIKE '%'||$5||'%' OR j.notes ILIKE '%'||$5||'%')`;
  return transaction(async (db) => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const [total] = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM journal_entries j WHERE ${where}`,
      values,
      db,
    );
    const limit = 50,
      page = Math.min(
        Math.max(1, input.page || 1),
        Math.max(1, Math.ceil(total.count / limit)),
      );
    const rows = await query<Journal>(
      `SELECT ${journalColumns} FROM journal_entries j WHERE ${where}
      ORDER BY j.booked_at DESC,j.created_at DESC,j.id DESC LIMIT $6 OFFSET $7`,
      [...values, limit, (page - 1) * limit],
      db,
    );
    return { rows, count: total.count, page, limit };
  });
}

function normalizedJournal(input: JournalInput) {
  validDate(input.date);
  if (!input.description.trim())
    throw new AppError("Enter a journal description.");
  if (input.postings.length < 2 || input.postings.length > 100)
    throw new AppError("Enter between 2 and 100 posting lines.");
  const money = (value: string | number) => {
    try {
      return parseMoney(value || "0", input.currency);
    } catch (error) {
      throw new AppError((error as Error).message);
    }
  };
  const postings = input.postings.map((line) => {
    const debit = money(line.debit),
      credit = money(line.credit);
    if (debit < 0 || credit < 0 || debit > 0 === credit > 0)
      throw new AppError(
        "Each line must have a positive debit or a positive credit, with the other side zero.",
      );
    return {
      accountId: line.accountId,
      amount: debit - credit,
      memo: line.memo.trim(),
    };
  });
  const total = postings.reduce((sum, line) => sum + BigInt(line.amount), 0n);
  if (total !== 0n)
    throw new AppError("Total debits must equal total credits.");
  const debits = postings.reduce(
    (sum, line) => sum + (line.amount > 0 ? BigInt(line.amount) : 0n),
    0n,
  );
  if (debits > BigInt(Number.MAX_SAFE_INTEGER))
    throw new AppError("Journal total is too large.");
  return {
    currency: input.currency,
    date: input.date,
    description: input.description.trim(),
    reference: input.reference.trim(),
    notes: input.notes.trim(),
    postings,
  };
}

async function validateAccounts(
  input: ReturnType<typeof normalizedJournal>,
  db: DB,
) {
  const ids = [...new Set(input.postings.map((line) => line.accountId))];
  const accounts = await query(
    "SELECT id,currency FROM ledger_accounts WHERE id=ANY($1::uuid[]) FOR KEY SHARE",
    [ids],
    db,
  );
  if (accounts.length !== ids.length)
    throw new AppError("One or more accounts no longer exist.");
  if (accounts.some((a) => a.currency !== input.currency))
    throw new AppError("All posting accounts must use the journal currency.");
}

async function insertPostings(
  id: string,
  input: ReturnType<typeof normalizedJournal>,
  db: DB,
) {
  for (const [position, line] of input.postings.entries())
    await db.query(
      "INSERT INTO journal_postings(entry_id,account_id,currency,amount,source,memo,position) VALUES($1,$2,$3,$4,'manual',$5,$6)",
      [id, line.accountId, input.currency, line.amount, line.memo, position],
    );
}

export async function createManualJournal(
  input: JournalInput,
  idempotencyKey: string,
) {
  const normalized = normalizedJournal(input),
    hash = digest(JSON.stringify(normalized));
  return transaction(async (db) => {
    await validateAccounts(normalized, db);
    const [entry] = await query<{ id: string }>(
      `INSERT INTO journal_entries(manual_key,currency,booked_at,description,reference,notes,creation_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(manual_key) DO NOTHING RETURNING id`,
      [
        idempotencyKey,
        normalized.currency,
        normalized.date,
        normalized.description,
        normalized.reference,
        normalized.notes,
        hash,
      ],
      db,
    );
    if (!entry) {
      const [existing] = await query(
        "SELECT id,creation_hash FROM journal_entries WHERE manual_key=$1",
        [idempotencyKey],
        db,
      );
      if (existing.creation_hash !== hash)
        throw new AppError(
          "This request was already used for a different journal entry. Reload the form.",
          409,
        );
      return journalDetail(existing.id, db);
    }
    await insertPostings(entry.id, normalized, db);
    return journalDetail(entry.id, db);
  });
}

async function editableJournal(id: string, version: number, db: DB) {
  const [entry] = await query<Journal>(
    "SELECT * FROM journal_entries WHERE id=$1 FOR UPDATE",
    [id],
    db,
  );
  if (!entry) throw new AppError("Journal entry not found.", 404);
  if (!entry.manual_key)
    throw new AppError(
      "Only manual journals can be edited here. Change the source transaction or opening balance instead.",
    );
  if (entry.version !== version)
    throw new AppError(
      "This journal changed since you opened it. Reload before saving.",
      409,
    );
  return entry;
}

export async function updateManualJournal(
  id: string,
  input: JournalInput,
  version: number,
) {
  const normalized = normalizedJournal(input);
  return transaction(async (db) => {
    const entry = await editableJournal(id, version, db);
    if (entry.currency !== normalized.currency)
      throw new AppError(
        "Keep the original journal currency. Create a new entry to use another currency.",
      );
    await validateAccounts(normalized, db);
    await db.query(
      "UPDATE journal_entries SET booked_at=$2,description=$3,reference=$4,notes=$5,version=version+1,updated_at=now() WHERE id=$1",
      [
        id,
        normalized.date,
        normalized.description,
        normalized.reference,
        normalized.notes,
      ],
    );
    await db.query("DELETE FROM journal_postings WHERE entry_id=$1", [id]);
    await insertPostings(id, normalized, db);
    return journalDetail(id, db);
  });
}

export async function deleteManualJournal(id: string, version: number) {
  return transaction(async (db) => {
    await editableJournal(id, version, db);
    await db.query("DELETE FROM journal_entries WHERE id=$1", [id]);
    return { ok: true };
  });
}

export async function createAccountingAccount(input: {
  code: string;
  name: string;
  type: AccountType;
  currency: string;
}) {
  try {
    const [account] = await query(
      "INSERT INTO ledger_accounts(code,display_code,name,type,currency) VALUES($1,$2,$3,$4,$5) RETURNING id",
      [
        `custom:${randomUUID()}`,
        input.code.trim().toUpperCase(),
        input.name.trim(),
        input.type,
        input.currency,
      ],
    );
    return account;
  } catch (error) {
    if (
      (error as { constraint?: string }).constraint ===
      "ledger_account_display_code"
    )
      throw new AppError("That account code already exists in this currency.");
    throw error;
  }
}

export async function generalLedger(
  accountId: string,
  input: { from?: string; to?: string; page?: number },
) {
  dates(input.from, input.to);
  return transaction(async (db) => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const [account] = await query<
      Pick<
        AccountingAccount,
        "id" | "code" | "display_code" | "name" | "type" | "currency"
      >
    >(
      `SELECT a.*,${accountName} AS name FROM ledger_accounts a
      LEFT JOIN accounts b ON b.id=a.source_account_id WHERE a.id=$1`,
      [accountId],
      db,
    );
    if (!account) throw new AppError("Accounting account not found.", 404);
    const values = [accountId, input.from || null, input.to || null];
    const [totals] = await query<{
      opening: number;
      closing: number;
      debit: number;
      credit: number;
      count: number;
    }>(
      `SELECT coalesce(sum(p.amount) FILTER(WHERE $2::date IS NOT NULL AND j.booked_at<$2),0)::bigint AS opening,
       coalesce(sum(p.amount) FILTER(WHERE $3::date IS NULL OR j.booked_at<=$3),0)::bigint AS closing,
       coalesce(sum(p.debit) FILTER(WHERE ($2::date IS NULL OR j.booked_at>=$2) AND ($3::date IS NULL OR j.booked_at<=$3)),0)::bigint AS debit,
       coalesce(sum(p.credit) FILTER(WHERE ($2::date IS NULL OR j.booked_at>=$2) AND ($3::date IS NULL OR j.booked_at<=$3)),0)::bigint AS credit,
       count(*) FILTER(WHERE ($2::date IS NULL OR j.booked_at>=$2) AND ($3::date IS NULL OR j.booked_at<=$3))::int AS count
       FROM journal_postings p JOIN journal_entries j ON j.id=p.entry_id WHERE p.account_id=$1`,
      values,
      db,
    );
    const limit = 50,
      page = Math.min(
        Math.max(1, input.page || 1),
        Math.max(1, Math.ceil(totals.count / limit)),
      );
    const order =
      "j.booked_at,CASE WHEN j.opening_account_id IS NOT NULL THEN 0 ELSE 1 END,j.created_at,j.id,p.position,p.id";
    const rows = await query<LedgerRow>(
      `SELECT p.id,p.entry_id,j.booked_at,j.description,j.reference,${origin} AS origin,p.memo,p.debit,p.credit,
       ($4::bigint + sum(p.amount) OVER (ORDER BY ${order} ROWS UNBOUNDED PRECEDING))::bigint AS balance
       FROM journal_postings p JOIN journal_entries j ON j.id=p.entry_id
       WHERE p.account_id=$1 AND ($2::date IS NULL OR j.booked_at>=$2) AND ($3::date IS NULL OR j.booked_at<=$3)
       ORDER BY ${order} LIMIT $5 OFFSET $6`,
      [...values, totals.opening, limit, (page - 1) * limit],
      db,
    );
    return { account, rows, page, limit, ...totals };
  });
}

export async function financialStatements(
  currency: string,
  from: string,
  to: string,
) {
  dates(from, to);
  const rows = await query<{
    id: string;
    name: string;
    type: AccountType;
    balance: number;
    period_amount: number;
  }>(
    `SELECT a.id,${accountName} AS name,a.type,coalesce(sum(p.amount),0)::bigint AS balance,
     coalesce(sum(p.amount) FILTER(WHERE j.booked_at>=$2),0)::bigint AS period_amount
     FROM ledger_accounts a LEFT JOIN accounts b ON b.id=a.source_account_id
     LEFT JOIN (journal_postings p JOIN journal_entries j ON j.id=p.entry_id AND j.booked_at<=$3::date) ON p.account_id=a.id
     WHERE a.currency=$1 GROUP BY a.id,b.nickname,b.name ORDER BY a.type,name`,
    [currency, from, to],
  );
  const sum = (
    types: AccountType[],
    field: "balance" | "period_amount",
    sign = 1,
  ) => {
    const amount = rows
      .filter((row) => types.includes(row.type))
      .reduce((total, row) => total + BigInt(row[field]) * BigInt(sign), 0n);
    if (
      amount > BigInt(Number.MAX_SAFE_INTEGER) ||
      amount < BigInt(Number.MIN_SAFE_INTEGER)
    )
      throw new AppError("Report total exceeds the supported amount range.");
    return Number(amount);
  };
  const income = sum(["income"], "period_amount", -1),
    expenses = sum(["expense"], "period_amount");
  const earnings = sum(["income", "expense"], "balance", -1);
  return {
    currency,
    from,
    to,
    rows,
    income,
    expenses,
    profit: sum(["income", "expense"], "period_amount", -1),
    assets: sum(["asset"], "balance"),
    liabilities: sum(["liability"], "balance", -1),
    equity: sum(["equity"], "balance", -1),
    earnings,
    total_equity: sum(["equity", "income", "expense"], "balance", -1),
    liabilities_and_equity: sum(
      ["liability", "equity", "income", "expense"],
      "balance",
      -1,
    ),
  };
}
