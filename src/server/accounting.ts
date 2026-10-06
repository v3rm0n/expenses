import { query, transaction, type DB, pool } from "./db";
import { validDate } from "../lib/money";
import { AppError } from "./errors";
import type { AccountType } from "../lib/accounting";

export async function trialBalance(
  currency: string,
  through?: string,
  db: DB = pool,
) {
  if (through) validDate(through);
  const rows = await query<{
    id: string;
    code: string;
    display_code: string | null;
    name: string;
    type: AccountType;
    currency: string;
    source_account_id: string | null;
    category_id: string | null;
    debit: number;
    credit: number;
    balance: number;
    opening_date: string | null;
    opening_balance: number;
    first_date: string | null;
    total_debit: number;
    total_credit: number;
    total_balance_debit: number;
    total_balance_credit: number;
  }>(
    `SELECT a.id,a.code,a.display_code,coalesce(nullif(b.nickname,''),b.name,a.name) AS name,
      a.type,a.currency,a.source_account_id,a.category_id,
      coalesce(sum(p.debit),0)::bigint AS debit,
      coalesce(sum(p.credit),0)::bigint AS credit,
      coalesce(sum(p.amount),0)::bigint AS balance,
      coalesce(sum(sum(p.debit)) OVER (),0)::bigint AS total_debit,
      coalesce(sum(sum(p.credit)) OVER (),0)::bigint AS total_credit,
      coalesce(sum(greatest(coalesce(sum(p.amount),0),0)) OVER (),0)::bigint AS total_balance_debit,
      coalesce(sum(greatest(-coalesce(sum(p.amount),0),0)) OVER (),0)::bigint AS total_balance_credit,
      o.booked_at AS opening_date,
      (SELECT min(fj.booked_at) FROM journal_entries fj JOIN journal_postings fp ON fp.entry_id=fj.id
        WHERE fp.account_id=a.id AND fj.opening_account_id IS NULL) AS first_date,
      coalesce((SELECT sum(op.amount) FROM journal_postings op WHERE op.entry_id=o.id AND op.account_id=a.id),0)::bigint AS opening_balance
    FROM ledger_accounts a LEFT JOIN accounts b ON b.id=a.source_account_id
    LEFT JOIN journal_entries o ON o.opening_account_id=a.id
    LEFT JOIN (journal_postings p JOIN journal_entries j ON j.id=p.entry_id AND ($2::date IS NULL OR j.booked_at<=$2)) ON p.account_id=a.id
    WHERE a.currency=$1 GROUP BY a.id,b.nickname,b.name,o.id,o.booked_at ORDER BY a.type,name,a.code`,
    [currency, through || null],
    db,
  );
  // Account rows and exact totals share one database snapshot.
  const accounts = rows.map(
    ({
      total_debit,
      total_credit,
      total_balance_debit,
      total_balance_credit,
      ...account
    }) => account,
  );
  return {
    currency,
    through: through || null,
    accounts,
    debit: rows[0]?.total_debit || 0,
    credit: rows[0]?.total_credit || 0,
    balance_debit: rows[0]?.total_balance_debit || 0,
    balance_credit: rows[0]?.total_balance_credit || 0,
  };
}

export async function transactionJournal(id: string) {
  const [entry] = await query("SELECT * FROM transactions WHERE id=$1", [id]);
  if (!entry) throw new AppError("Transaction not found.", 404);
  const [journal] = await query(
    "SELECT * FROM journal_entries WHERE transaction_id=$1",
    [id],
  );
  if (!journal) return { journal: null, postings: [] };
  const postings = await query(
    `SELECT p.*,a.code,coalesce(nullif(b.nickname,''),b.name,a.name) AS name,a.type
     FROM journal_postings p JOIN ledger_accounts a ON a.id=p.account_id
     LEFT JOIN accounts b ON b.id=a.source_account_id WHERE p.entry_id=$1 ORDER BY p.amount DESC,a.code`,
    [journal.id],
  );
  return { journal, postings };
}

// A balance at the beginning of the date, before any imported activity that day.
export async function setOpeningBalance(
  accountId: string,
  amount: number,
  date: string,
) {
  validDate(date);
  if (!Number.isSafeInteger(amount))
    throw new AppError("Enter an exact opening balance.");
  return transaction(async (db) => {
    const [account] = await query(
      "SELECT * FROM ledger_accounts WHERE id=$1 FOR UPDATE",
      [accountId],
      db,
    );
    if (
      !account ||
      account.type !== "asset" ||
      account.code.startsWith("transfers:")
    )
      throw new AppError(
        "Choose a bank, cash, investment, or pension asset account.",
      );
    const [first] = await query(
      `SELECT min(j.booked_at) AS date FROM journal_entries j JOIN journal_postings p ON p.entry_id=j.id
       WHERE p.account_id=$1 AND j.opening_account_id IS NULL`,
      [accountId],
      db,
    );
    if (first.date && date > first.date)
      throw new AppError(
        `Opening balance date must be on or before ${first.date}.`,
      );
    const [previous] = await query(
      "SELECT id FROM journal_entries WHERE opening_account_id=$1",
      [accountId],
      db,
    );
    if (previous)
      await db.query("DELETE FROM journal_entries WHERE id=$1", [previous.id]);
    if (!amount) return { ok: true };
    const [equity] = await query(
      "SELECT ensure_ledger_account($1,'Opening balances','equity',$2) AS id",
      [`equity:opening:${account.currency}`, account.currency],
      db,
    );
    const [entry] = await query(
      "INSERT INTO journal_entries(opening_account_id,currency,booked_at,description) VALUES($1,$2,$3,'Opening balance') RETURNING id",
      [account.id, account.currency, date],
      db,
    );
    await db.query(
      "INSERT INTO journal_postings(entry_id,account_id,currency,amount,source) VALUES($1,$2,$3,$4,'opening'),($1,$5,$3,$6,'opening')",
      [entry.id, account.id, account.currency, amount, equity.id, -amount],
    );
    return { ok: true };
  });
}
