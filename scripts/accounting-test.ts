import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isolatedDatabase } from "./test-database";
import { CATEGORY_SEEDS } from "../src/lib/types";

const database = await isolatedDatabase("accounting");
process.env.DATABASE_URL = database.url;
const { query, transaction, migrate, pool } = await import("../src/server/db");
const { trialBalance, transactionJournal, setOpeningBalance } =
  await import("../src/server/accounting");
const { overview } = await import("../src/server/reporting");
const { importBankTransactions } = await import("../src/server/banking");
const { replaceAllocations } = await import("../src/server/ledger");
let checks = 0;
const check = async (name: string, fn: () => Promise<void>) => {
  await fn();
  checks++;
  console.log(`✓ ${name}`);
};
try {
  // Start with real pre-conversion history rather than only testing a fresh database.
  await query(await readFile("migrations/001-initial.sql", "utf8"));
  for (const [id, name, color] of CATEGORY_SEEDS)
    await query("INSERT INTO categories VALUES($1,$2,$3)", [id, name, color]);
  const [bank] = await query(
    "INSERT INTO accounts(identification_hash,name,currency) VALUES('accounting-bank','Bank','EUR') RETURNING id",
  );
  const [savings] = await query(
    "INSERT INTO accounts(identification_hash,name,currency) VALUES('accounting-savings','Savings','EUR') RETURNING id",
  );
  const [cash] = await query(
    "INSERT INTO accounts(identification_hash,name,currency,source) VALUES('cash:EUR','Cash','EUR','cash') RETURNING id",
  );
  const [purchase] = await query(
    "INSERT INTO transactions(account_id,source_key,amount,currency,kind,booked_at,merchant) VALUES($1,'legacy',-5000,'EUR','expense','2026-01-02','Market') RETURNING id",
    [bank.id],
  );
  await query(
    "INSERT INTO allocations VALUES($1,'groceries',3000,'manual'),($1,'household',2000,'manual')",
    [purchase.id],
  );
  const [pending] = await query(
    "INSERT INTO transactions(account_id,source_key,amount,currency,kind,status,booked_at,merchant) VALUES($1,'pending',-700,'EUR','expense','PDNG',NULL,'Shop') RETURNING id",
    [bank.id],
  );
  await migrate();
  const balance = async (code: string) =>
    (await trialBalance("EUR")).accounts.find((a) => a.code === code)
      ?.balance || 0;
  const bankCode = `bank:${bank.id}:EUR`;
  const savingsCode = `bank:${savings.id}:EUR`;
  const add = async (
    key: string,
    amount: number,
    kind: string,
    accountId = bank.id,
    currency = "EUR",
  ) => {
    const [row] = await query(
      "INSERT INTO transactions(account_id,source_key,amount,currency,kind,booked_at,merchant) VALUES($1,$2,$3,$4,$5,'2026-01-03',$2) RETURNING id",
      [accountId, key, amount, currency, kind],
    );
    return row.id as string;
  };
  await check(
    "migration backfills split history without posting pending payments, and reruns safely",
    async () => {
      const journal = await transactionJournal(purchase.id);
      assert.equal(journal.postings.length, 3);
      assert.deepEqual(
        journal.postings.map((p) => [p.code, p.amount]).sort(),
        [
          [bankCode, -5000],
          ["expense:groceries:EUR", 3000],
          ["expense:household:EUR", 2000],
        ].sort(),
      );
      assert.equal((await transactionJournal(pending.id)).journal, null);
      assert.equal(await balance(bankCode), -5000);
      const entries = await query(
        "SELECT count(*)::int AS count FROM journal_entries",
      );
      delete (
        globalThis as typeof globalThis & { expenseMigration?: Promise<void> }
      ).expenseMigration;
      await migrate();
      assert.deepEqual(
        await query("SELECT count(*)::int AS count FROM journal_entries"),
        entries,
      );
    },
  );
  await check(
    "recategorization, refunds, income, and reports use balanced journal postings",
    async () => {
      await transaction((db) =>
        replaceAllocations(
          purchase.id,
          [{ categoryId: "groceries", amount: 5000, source: "manual" }],
          5000,
          db,
        ),
      );
      const refund = await add("refund", 1000, "refund");
      await transaction((db) =>
        replaceAllocations(
          refund,
          [{ categoryId: "groceries", amount: -1000, source: "manual" }],
          -1000,
          db,
        ),
      );
      await add("salary", 10000, "income");
      assert.equal(await balance("expense:groceries:EUR"), 4000);
      assert.equal(await balance("expense:household:EUR"), 0);
      assert.equal(await balance("income:EUR"), -10000);
      const report = await overview("2026-01", "EUR");
      assert.equal(report.spending, 4000);
      assert.equal(report.income, 10000);
      assert.equal(
        report.categories.find((a) => a.id === "groceries")?.amount,
        4000,
      );
    },
  );
  await check(
    "both transfer sides clear without double-counting bank balances",
    async () => {
      const before = await balance(bankCode);
      await add("transfer-out", -2000, "transfer");
      assert.equal(await balance("transfers:EUR"), 2000);
      await add("transfer-in", 2000, "transfer", savings.id);
      assert.equal(await balance("transfers:EUR"), 0);
      assert.equal(await balance(bankCode), before - 2000);
      assert.equal(await balance(savingsCode), 2000);
    },
  );
  await check(
    "withdrawals and cash spending share a cash asset; investments retain constant value",
    async () => {
      await add("atm", -3000, "cash_movement");
      await add("cash-purchase", -1200, "expense", cash.id);
      await add("cash-income", 500, "income", cash.id);
      assert.equal(await balance("cash:EUR"), 2300);
      assert.equal((await overview("2026-01", "EUR")).cash.amount, 2300);
      await add("investment", -800, "investment");
      await add("investment-return", 200, "investment");
      await add("pension", -400, "pension");
      assert.equal(await balance("investment:EUR"), 600);
      assert.equal(await balance("pension:EUR"), 400);
    },
  );
  await check(
    "contributions to a tracked account clear against its imported side without duplicating assets",
    async () => {
      await query("UPDATE accounts SET iban='EE123456789' WHERE id=$1", [
        savings.id,
      ]);
      const beforeInvestment = await balance("investment:EUR");
      const beforeSavings = await balance(savingsCode);
      const id = await add("tracked-contribution", -600, "investment");
      await query(
        "UPDATE transactions SET counterparty_iban='ee12 3456789' WHERE id=$1",
        [id],
      );
      await add("tracked-contribution-in", 600, "transfer", savings.id);
      assert.equal(await balance("investment:EUR"), beforeInvestment);
      assert.equal(await balance(savingsCode), beforeSavings + 600);
      assert.equal(await balance("transfers:EUR"), 0);
      await query("UPDATE accounts SET iban=NULL WHERE id=$1", [savings.id]);
      assert.equal(await balance("investment:EUR"), beforeInvestment + 600);
      await query("UPDATE accounts SET iban='EE123456789' WHERE id=$1", [
        savings.id,
      ]);
      assert.equal(await balance("investment:EUR"), beforeInvestment);
    },
  );
  await check(
    "booking, superseding, deletion, and bank reimports update journals without duplicates",
    async () => {
      await query(
        "UPDATE transactions SET status='BOOK',booked_at='2026-01-04' WHERE id=$1",
        [pending.id],
      );
      assert.equal((await transactionJournal(pending.id)).postings.length, 2);
      await query("UPDATE transactions SET status='SUPERSEDED' WHERE id=$1", [
        pending.id,
      ]);
      assert.equal((await transactionJournal(pending.id)).journal, null);
      const id = await add("delete-me", -125, "expense");
      const before = await balance(bankCode);
      await query("DELETE FROM transactions WHERE id=$1", [id]);
      assert.equal(await balance(bankCode), before + 125);
      const raw = {
        entry_reference: "reimport",
        transaction_amount: { amount: "10.00", currency: "EUR" },
        credit_debit_indicator: "DBIT" as const,
        booking_date: "2026-01-05",
        creditor: { name: "Rimi" },
      };
      await importBankTransactions(bank.id, [raw]);
      await importBankTransactions(bank.id, [
        { ...raw, transaction_amount: { amount: "12.00", currency: "EUR" } },
      ]);
      const [entry] = await query(
        "SELECT id FROM transactions WHERE source_key='ref:reimport'",
      );
      assert.equal(
        (await transactionJournal(entry.id)).postings.find(
          (p) => p.code === bankCode,
        )?.amount,
        -1200,
      );
      assert.equal(
        (
          await query(
            "SELECT count(*)::int AS count FROM journal_entries WHERE transaction_id=$1",
            [entry.id],
          )
        )[0].count,
        1,
      );
    },
  );
  await check(
    "opening balances offset equity, can be replaced or removed, and respect history dates",
    async () => {
      const account = (await trialBalance("EUR")).accounts.find(
        (a) => a.code === bankCode,
      )!;
      const before = await balance(bankCode);
      await setOpeningBalance(account.id, 20000, "2026-01-01");
      assert.equal(await balance(bankCode), before + 20000);
      assert.equal(await balance("equity:opening:EUR"), -20000);
      const earlier = await trialBalance("EUR", "2026-01-01");
      assert.equal(
        earlier.accounts.find((a) => a.id === account.id)?.balance,
        20000,
      );
      await setOpeningBalance(account.id, 15000, "2026-01-01");
      assert.equal(await balance(bankCode), before + 15000);
      await assert.rejects(
        setOpeningBalance(account.id, 500, "2026-02-01"),
        /on or before/,
      );
      await setOpeningBalance(account.id, 0, "2026-01-01");
      assert.equal(await balance(bankCode), before);
    },
  );
  await check(
    "database rejects unbalanced, empty, mismatched, and cross-currency journals",
    async () => {
      const journal = await transactionJournal(purchase.id);
      await assert.rejects(
        transaction(async (db) => {
          await db.query(
            "UPDATE journal_postings SET amount=amount+1 WHERE id=$1",
            [journal.postings[0].id],
          );
        }),
        /equal debits and credits/,
      );
      await assert.rejects(
        transaction(async (db) => {
          await db.query("DELETE FROM journal_postings WHERE entry_id=$1", [
            journal.journal!.id,
          ]);
        }),
        /at least two postings/,
      );
      await assert.rejects(
        transaction(async (db) => {
          await db.query("DELETE FROM journal_entries WHERE id=$1", [
            journal.journal!.id,
          ]);
        }),
        /exactly one journal/,
      );
      await assert.rejects(
        transaction(async (db) => {
          await db.query(
            "UPDATE journal_postings SET amount=amount*2 WHERE entry_id=$1",
            [journal.journal!.id],
          );
        }),
        /match its booked transaction/,
      );
      const usd = await add("usd-purchase", -99, "expense", bank.id, "USD");
      const foreign = await transactionJournal(usd);
      await assert.rejects(
        query("UPDATE journal_postings SET account_id=$1 WHERE id=$2", [
          foreign.postings[0].account_id,
          journal.postings[0].id,
        ]),
        /foreign key constraint/,
      );
      const eur = await trialBalance("EUR");
      const dollars = await trialBalance("USD");
      assert.equal(eur.debit, eur.credit);
      assert.equal(dollars.debit, dollars.credit);
      assert.equal(
        dollars.accounts.find((a) => a.code === `bank:${bank.id}:USD`)?.balance,
        -99,
      );
    },
  );
  await check(
    "every booked transaction has a balanced journal and every pending transaction has none",
    async () => {
      assert.equal(
        (
          await query(
            "SELECT j.id FROM journal_entries j LEFT JOIN journal_postings p ON p.entry_id=j.id GROUP BY j.id HAVING count(p.id)<2 OR sum(p.amount)<>0",
          )
        ).length,
        0,
      );
      assert.equal(
        (
          await query(
            "SELECT t.id FROM transactions t LEFT JOIN journal_entries j ON j.transaction_id=t.id WHERE (t.status='BOOK')<>(j.id IS NOT NULL)",
          )
        ).length,
        0,
      );
    },
  );
  console.log(`${checks} accounting checks passed in an isolated database.`);
} finally {
  await pool.end();
  await database.dispose();
}
