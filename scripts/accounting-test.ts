import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isolatedDatabase } from "./test-database";
import { CATEGORY_SEEDS } from "../src/lib/types";
import { randomUUID } from "node:crypto";
import type { JournalInput } from "../src/lib/accounting";

const database = await isolatedDatabase("accounting");
process.env.DATABASE_URL = database.url;
const { query, transaction, migrate, pool } = await import("../src/server/db");
const { trialBalance, transactionJournal, setOpeningBalance } =
  await import("../src/server/accounting");
const { overview } = await import("../src/server/reporting");
const { importBankTransactions } = await import("../src/server/banking");
const { replaceAllocations } = await import("../src/server/ledger");
const {
  createAccountingAccount,
  createManualJournal,
  updateManualJournal,
  deleteManualJournal,
  journalDetail,
  journalPage,
  generalLedger,
  financialStatements,
} = await import("../src/server/bookkeeping");
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
  const manualAsset = await createAccountingAccount({
    code: "1100",
    name: "Manual wallet",
    type: "asset",
    currency: "EUR",
  });
  const manualLiability = await createAccountingAccount({
    code: "2100",
    name: "Loan payable",
    type: "liability",
    currency: "EUR",
  });
  const manualExpense = await createAccountingAccount({
    code: "6100",
    name: "Manual costs",
    type: "expense",
    currency: "EUR",
  });
  const manualIncome = await createAccountingAccount({
    code: "4100",
    name: "Manual revenue",
    type: "income",
    currency: "EUR",
  });
  const loanInput: JournalInput = {
    currency: "EUR",
    date: "2026-01-15",
    description: "Manual loan",
    reference: "LN-1",
    notes: "Initial funding",
    postings: [
      {
        accountId: manualAsset.id,
        debit: "100.00",
        credit: "0",
        memo: "Funds received",
      },
      {
        accountId: manualLiability.id,
        debit: "0",
        credit: "100.00",
        memo: "Amount owed",
      },
    ],
  };
  const loanKey = randomUUID();
  const loan = await createManualJournal(loanInput, loanKey);
  await check(
    "manual journals post atomically, preserve memos, and deduplicate retries",
    async () => {
      assert.equal(loan.journal.origin, "manual");
      assert.equal(loan.journal.debit, 10000);
      assert.equal(loan.journal.credit, 10000);
      assert.equal(loan.postings[0].memo, "Funds received");
      await assert.rejects(
        createManualJournal(
          {
            ...loanInput,
            postings: [
              { ...loanInput.postings[0], debit: "100.001" },
              loanInput.postings[1],
            ],
          },
          randomUUID(),
        ),
        (error: unknown) =>
          (error as { status: number }).status === 400 &&
          /decimal places/.test((error as Error).message),
      );
      const repeated = await Promise.all([
        createManualJournal(loanInput, loanKey),
        createManualJournal(loanInput, loanKey),
      ]);
      assert.ok(repeated.every((j) => j.journal.id === loan.journal.id));
      await assert.rejects(
        createManualJournal(
          { ...loanInput, description: "Different" },
          loanKey,
        ),
        /already used/,
      );
      const before = (
        await query("SELECT count(*)::int AS count FROM journal_entries")
      )[0].count;
      await assert.rejects(
        createManualJournal(
          {
            ...loanInput,
            postings: [
              {
                accountId: manualAsset.id,
                debit: "100.01",
                credit: "0",
                memo: "",
              },
              loanInput.postings[1],
            ],
          },
          randomUUID(),
        ),
        /equal total credits/,
      );
      await assert.rejects(
        createManualJournal(
          {
            ...loanInput,
            postings: [
              { ...loanInput.postings[0], credit: "1.00" },
              loanInput.postings[1],
            ],
          },
          randomUUID(),
        ),
        /positive debit or/,
      );
      const [usdAccount] = await query(
        "SELECT id FROM ledger_accounts WHERE currency='USD' LIMIT 1",
      );
      await assert.rejects(
        createManualJournal(
          {
            ...loanInput,
            postings: [
              { ...loanInput.postings[0], accountId: usdAccount.id },
              loanInput.postings[1],
            ],
          },
          randomUUID(),
        ),
        /journal currency/,
      );
      assert.equal(
        (await query("SELECT count(*)::int AS count FROM journal_entries"))[0]
          .count,
        before,
      );
      await assert.rejects(
        createAccountingAccount({
          code: "1100",
          name: "Duplicate",
          type: "asset",
          currency: "EUR",
        }),
        /already exists/,
      );
      await createAccountingAccount({
        code: "1100",
        name: "USD wallet",
        type: "asset",
        currency: "USD",
      });
    },
  );
  await createManualJournal(
    {
      ...loanInput,
      date: "2026-02-02",
      description: "Split manual cost",
      reference: "COST-1",
      postings: [
        {
          accountId: manualExpense.id,
          debit: "15.00",
          credit: "0",
          memo: "First cost",
        },
        {
          accountId: manualExpense.id,
          debit: "10.00",
          credit: "0",
          memo: "Second cost",
        },
        {
          accountId: manualAsset.id,
          debit: "0",
          credit: "25.00",
          memo: "Payment",
        },
      ],
    },
    randomUUID(),
  );
  await createManualJournal(
    {
      ...loanInput,
      date: "2026-02-10",
      description: "Manual income",
      postings: [
        {
          accountId: manualAsset.id,
          debit: "60.00",
          credit: "0",
          memo: "Income",
        },
        {
          accountId: manualIncome.id,
          debit: "0",
          credit: "60.00",
          memo: "Revenue",
        },
      ],
    },
    randomUUID(),
  );
  await check(
    "general ledger opens with earlier history and reports exact running and closing balances",
    async () => {
      const ledger = await generalLedger(manualAsset.id, {
        from: "2026-02-01",
        to: "2026-02-28",
      });
      assert.equal(ledger.opening, 10000);
      assert.equal(ledger.closing, 13500);
      assert.equal(ledger.debit, 6000);
      assert.equal(ledger.credit, 2500);
      assert.deepEqual(
        ledger.rows.map((r) => r.balance),
        [7500, 13500],
      );
      assert.equal(
        (
          await journalPage({
            currency: "EUR",
            origin: "manual",
            search: "COST-1",
          })
        ).count,
        1,
      );
      await assert.rejects(
        generalLedger(manualAsset.id, { from: "2026-03-01", to: "2026-02-01" }),
        /Start date/,
      );
      await assert.rejects(
        setOpeningBalance(manualAsset.id, 100, "2026-02-01"),
        /on or before/,
      );
    },
  );
  await check(
    "trial balance and financial statements include manual asset, liability, income, and expense postings",
    async () => {
      const trial = await trialBalance("EUR", "2026-02-28");
      assert.equal(trial.balance_debit, trial.balance_credit);
      assert.equal(
        trial.accounts.find((a) => a.id === manualAsset.id)?.balance,
        13500,
      );
      assert.equal(
        trial.accounts.find((a) => a.id === manualLiability.id)?.balance,
        -10000,
      );
      const statement = await financialStatements(
        "EUR",
        "2026-02-01",
        "2026-02-28",
      );
      assert.equal(statement.income, 6000);
      assert.equal(statement.expenses, 2500);
      assert.equal(statement.profit, 3500);
      assert.equal(
        statement.assets,
        statement.liabilities + statement.equity + statement.earnings,
      );
      assert.equal((await overview("2026-02", "EUR")).spending, 0);
    },
  );
  await check(
    "pagination retains the full period totals and running balance across pages",
    async () => {
      for (let i = 0; i < 51; i++)
        await createManualJournal(
          {
            ...loanInput,
            date: "2026-03-01",
            description: `Pagination ${i}`,
            postings: [
              {
                accountId: manualAsset.id,
                debit: "0.01",
                credit: "0",
                memo: "",
              },
              {
                accountId: manualLiability.id,
                debit: "0",
                credit: "0.01",
                memo: "",
              },
            ],
          },
          randomUUID(),
        );
      const first = await generalLedger(manualAsset.id, {
        from: "2026-03-01",
        to: "2026-03-31",
        page: 1,
      });
      const second = await generalLedger(manualAsset.id, {
        from: "2026-03-01",
        to: "2026-03-31",
        page: 2,
      });
      assert.equal(first.count, 51);
      assert.equal(first.rows.length, 50);
      assert.equal(second.rows.length, 1);
      assert.equal(first.rows[49].balance, 13550);
      assert.equal(second.rows[0].balance, 13551);
      assert.equal(first.closing, 13551);
      assert.equal(second.closing, 13551);
      const journals = await journalPage({
        currency: "EUR",
        origin: "manual",
        from: "2026-03-01",
        to: "2026-03-31",
        page: 2,
      });
      assert.equal(journals.count, 51);
      assert.equal(journals.rows.length, 1);
    },
  );
  await check(
    "manual edits reject stale versions and imported journals, and deletion removes only manual postings",
    async () => {
      const changed = await updateManualJournal(
        loan.journal.id,
        {
          ...loanInput,
          reference: "LN-2",
          postings: loanInput.postings.map((p) => ({
            ...p,
            debit: p.debit === "0" ? "0" : "110.00",
            credit: p.credit === "0" ? "0" : "110.00",
          })),
        },
        loan.journal.version,
      );
      assert.equal(changed.journal.version, 2);
      assert.equal(changed.journal.debit, 11000);
      await assert.rejects(
        updateManualJournal(loan.journal.id, loanInput, 1),
        /changed since/,
      );
      await assert.rejects(
        deleteManualJournal(loan.journal.id, 1),
        /changed since/,
      );
      const source = await transactionJournal(purchase.id);
      await assert.rejects(
        updateManualJournal(source.journal!.id, loanInput, 1),
        /Only manual/,
      );
      await assert.rejects(
        deleteManualJournal(source.journal!.id, 1),
        /Only manual/,
      );
      await deleteManualJournal(loan.journal.id, changed.journal.version);
      await assert.rejects(journalDetail(loan.journal.id), /not found/);
      assert.equal(
        (
          await query("SELECT id FROM journal_postings WHERE entry_id=$1", [
            loan.journal.id,
          ])
        ).length,
        0,
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
