import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { generateKeyPairSync } from "node:crypto";
import { isolatedDatabase } from "./test-database";
import {
  receiptText,
  textPdf,
  scannedPdf,
  selverCsv,
  woltReceiptText,
  woltOrderId,
  lidlReceiptText,
  coopReceiptText,
} from "../tests/fixtures";
import type { BankTransaction } from "../src/lib/types";
const database = await isolatedDatabase("integration"),
  restored = await isolatedDatabase("restore");
const temporary = await mkdtemp(path.join(tmpdir(), "expenses-test-"));
process.env.DATABASE_URL = database.url;
process.env.DATA_DIR = path.join(temporary, "originals");
const signingKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).privateKey.export({ type: "pkcs8", format: "pem" });
await writeFile(path.join(temporary, "test-signing-key.pem"), signingKey, {
  mode: 0o600,
});
process.env.ENABLE_BANKING_APP_ID = "test-application";
process.env.ENABLE_BANKING_PRIVATE_KEY_PATH = path.join(
  temporary,
  "test-signing-key.pem",
);
const { query, transaction, migrate, pool } = await import("../src/server/db");
const {
  importBankTransactions,
  bankFingerprint,
  syncBank,
  completeBankAuthorization,
} = await import("../src/server/banking");
const { storeReceipt, processReceipt, extractDocument } =
  await import("../src/server/receipts");
const { overview, receiptDetail, receiptPage, receiptList } =
  await import("../src/server/reporting");
const { receiveEmail, processEmail, readEmailMessage } =
  await import("../src/server/email");
const { applyAllocations, linkReceipt, reclassify } =
  await import("../src/server/ledger");
const { getQueue } = await import("../src/server/queue");
const { writeBackup, restoreBackup } = await import("./archive");
const { config } = await import("../src/server/config");
const { encrypt, digest } = await import("../src/server/crypto");
let checks = 0;
const check = (message: string, fn: () => Promise<void>) =>
  fn().then(() => {
    checks++;
    console.log(`✓ ${message}`);
  });
try {
  await migrate();
  await check(
    "Lidl credentials and sessions stay encrypted; account changes reset authentication",
    async () => {
      const { saveLidl, lidlStatus } = await import("../src/server/lidl");
      const { decrypt } = await import("../src/server/crypto");
      await saveLidl({
        user: "test@example.com",
        password: "test-password",
        enabled: false,
      });
      let [setting] = await query(
        "SELECT value FROM settings WHERE key='lidl'",
      );
      assert.ok(!JSON.stringify(setting.value).includes("test-password"));
      assert.equal(
        decrypt<{ password: string }>(setting.value.cipher).password,
        "test-password",
      );
      assert.equal((await lidlStatus())?.hasPassword, true);
      assert.ok(!JSON.stringify(await lidlStatus()).includes("test-password"));
      await saveLidl({ user: "test@example.com", enabled: true });
      [setting] = await query("SELECT value FROM settings WHERE key='lidl'");
      assert.equal(
        decrypt<{ password: string }>(setting.value.cipher).password,
        "test-password",
      );
      await assert.rejects(
        saveLidl({ user: "other@example.com", enabled: true }),
        /password/,
      );
      await saveLidl({
        user: "other@example.com",
        password: "replacement",
        enabled: false,
      });
      [setting] = await query("SELECT value FROM settings WHERE key='lidl'");
      assert.equal(
        decrypt<{ password: string }>(setting.value.cipher).password,
        "replacement",
      );
      await query("DELETE FROM settings WHERE key='lidl'");
    },
  );
  const [account] = await query(
    "INSERT INTO accounts(identification_hash,iban,name,currency) VALUES('wallet:EUR','EEOWNER','Revolut EUR','EUR') RETURNING id",
  );
  const [usd] = await query(
    "INSERT INTO accounts(identification_hash,iban,name,currency) VALUES('wallet:USD','EEOWNER','Revolut USD','USD') RETURNING id",
  );
  const bank = (
    reference: string | undefined,
    amount = "5.10",
    merchant = "Rimi",
    currency = "EUR",
    direction: "DBIT" | "CRDT" = "DBIT",
  ): BankTransaction => ({
    entry_reference: reference,
    transaction_id: "unstable",
    transaction_amount: { amount, currency },
    credit_debit_indicator: direction,
    booking_date: "2026-10-02",
    status: "BOOK",
    creditor: { name: merchant },
    debtor: { name: merchant },
    remittance_information: [],
  });
  await check(
    "repeated bank imports and unstable transaction IDs do not duplicate",
    async () => {
      assert.equal(
        await transaction((db) =>
          importBankTransactions(account.id, [bank("rimi1")], db),
        ),
        1,
      );
      assert.equal(
        await transaction((db) =>
          importBankTransactions(
            account.id,
            [{ ...bank("rimi1"), transaction_id: "different" }],
            db,
          ),
        ),
        0,
      );
      assert.equal(
        (await query("SELECT count(*)::int AS n FROM transactions"))[0].n,
        1,
      );
    },
  );
  await check(
    "identical purchases without references survive as a multiset",
    async () => {
      const record = bank(undefined, "1.00", "Coop");
      assert.equal(
        await transaction((db) =>
          importBankTransactions(account.id, [record, record], db),
        ),
        2,
      );
      assert.equal(
        await transaction((db) =>
          importBankTransactions(account.id, [record, record], db),
        ),
        0,
      );
      assert.equal(
        bankFingerprint(record),
        bankFingerprint({
          ...record,
          transaction_amount: { currency: "EUR", amount: "1.000" },
        }),
      );
    },
  );
  await check(
    "pending payments are superseded only when the predecessor is unique",
    async () => {
      await transaction((db) =>
        importBankTransactions(
          account.id,
          [{ ...bank("pending", "2.00", "Lidl"), status: "PDNG" }],
          db,
        ),
      );
      await transaction((db) =>
        importBankTransactions(
          account.id,
          [bank("booked", "2.00", "Lidl")],
          db,
        ),
      );
      assert.equal(
        (
          await query(
            "SELECT status FROM transactions WHERE source_key='ref:pending'",
          )
        )[0].status,
        "SUPERSEDED",
      );
      await transaction((db) =>
        importBankTransactions(
          account.id,
          [
            {
              ...bank("undated-pending", "0.50", "Coop"),
              booking_date: undefined,
              status: "PDNG",
            },
          ],
          db,
        ),
      );
      assert.equal(
        (
          await query(
            "SELECT booked_at FROM transactions WHERE source_key='ref:undated-pending'",
          )
        )[0].booked_at,
        null,
      );
      await transaction((db) =>
        importBankTransactions(
          account.id,
          [bank("undated-booked", "0.50", "Coop")],
          db,
        ),
      );
      assert.equal(
        (
          await query(
            "SELECT status FROM transactions WHERE source_key='ref:undated-pending'",
          )
        )[0].status,
        "SUPERSEDED",
      );
      // Remove this auxiliary booked fixture to preserve subsequent expected totals.
      await query(
        "DELETE FROM transactions WHERE source_key='ref:undated-booked'",
      );
    },
  );
  await check(
    "multi-currency wallets, refunds, transfers and ATM cash stay separate",
    async () => {
      await transaction((db) =>
        importBankTransactions(
          usd.id,
          [bank("usd", "100.00", "Lidl", "USD")],
          db,
        ),
      );
      await transaction((db) =>
        importBankTransactions(
          account.id,
          [
            bank("salary", "1000.00", "Salary", "EUR", "CRDT"),
            bank("refund", "1.00", "Rimi refund", "EUR", "CRDT"),
            {
              ...bank("transfer", "50.00", "Savings"),
              creditor_account: { iban: "EEOWNER" },
            },
            bank("atm", "20.00", "ATM withdrawal"),
          ],
          db,
        ),
      );
      const eur = await overview("2026-10", "EUR"),
        dollars = await overview("2026-10", "USD");
      assert.equal(eur.spending, 810);
      assert.equal(eur.income, 100000);
      assert.equal(dollars.spending, 10000);
      assert.equal(eur.cash.amount, 2000);
    },
  );
  await check(
    "missing bank dates roll back the import rather than inventing dates",
    async () => {
      await assert.rejects(
        transaction((db) =>
          importBankTransactions(
            account.id,
            [{ ...bank("bad-date"), booking_date: undefined }],
            db,
          ),
        ),
      );
      assert.equal(
        (
          await query(
            "SELECT count(*)::int AS n FROM transactions WHERE source_key='ref:bad-date'",
          )
        )[0].n,
        0,
      );
    },
  );
  let receiptId = "";
  await check(
    "validated receipt auto-matches once and enriches categories without changing totals",
    async () => {
      const before = await overview("2026-10", "EUR");
      const receipt = await storeReceipt(
        Buffer.from(receiptText()),
        "receipt.txt",
      );
      receiptId = receipt.id;
      await processReceipt(receiptId);
      assert.equal(
        (await query("SELECT status FROM receipts WHERE id=$1", [receiptId]))[0]
          .status,
        "matched",
      );
      const after = await overview("2026-10", "EUR");
      assert.equal(after.spending, before.spending);
      assert.equal(
        after.categories.find((c) => c.id === "household")?.amount,
        300,
      );
    },
  );
  await check(
    "duplicate documents and reprocessing preserve one receipt/payment",
    async () => {
      assert.equal(
        (await storeReceipt(Buffer.from(receiptText()), "again.txt")).duplicate,
        true,
      );
      const second = await storeReceipt(
        Buffer.from(receiptText() + "\nThank you"),
        "other-export.txt",
      );
      await processReceipt(second.id);
      assert.equal(
        (
          await query("SELECT duplicate_of FROM receipts WHERE id=$1", [
            second.id,
          ])
        )[0].duplicate_of,
        receiptId,
      );
      await processReceipt(receiptId);
      assert.equal(
        (
          await query(
            "SELECT count(*)::int AS n FROM receipt_payments WHERE receipt_id=$1",
            [receiptId],
          )
        )[0].n,
        1,
      );
    },
  );
  await check(
    "conflicting receipt totals require review instead of silent deduplication",
    async () => {
      const changed = await storeReceipt(
        Buffer.from(
          receiptText()
            .replace(/5,10/g, "6,10")
            .replace("Piim 2,00", "Piim 3,00"),
        ),
        "corrected.txt",
      );
      await processReceipt(changed.id);
      assert.equal(
        (
          await query("SELECT status FROM receipts WHERE id=$1", [changed.id])
        )[0].status,
        "review",
      );
    },
  );
  await check("ambiguous identical payments remain unmatched", async () => {
    const receipt = await storeReceipt(
      Buffer.from("Coop\nReceipt nr 777\n02.10.2026\nPiim 1,00\nKokku 1,00"),
      "ambiguous.txt",
    );
    await processReceipt(receipt.id);
    assert.equal(
      (await query("SELECT status FROM receipts WHERE id=$1", [receipt.id]))[0]
        .status,
      "ready",
    );
  });
  await check(
    "manual categories survive reimport and automatic rules",
    async () => {
      const [entry] = await query(
        "SELECT id FROM transactions WHERE source_key='ref:rimi1'",
      );
      await query("UPDATE transactions SET manual=true WHERE id=$1", [
        entry.id,
      ]);
      await query("DELETE FROM allocations WHERE transaction_id=$1", [
        entry.id,
      ]);
      await query("INSERT INTO allocations VALUES($1,'gifts',510,'manual')", [
        entry.id,
      ]);
      await transaction((db) =>
        importBankTransactions(account.id, [bank("rimi1")], db),
      );
      await applyAllocations(entry.id);
      assert.equal(
        (
          await query(
            "SELECT category_id FROM allocations WHERE transaction_id=$1",
            [entry.id],
          )
        )[0].category_id,
        "gifts",
      );
    },
  );
  await check(
    "investment and pension contributions are separate from spending with exact cash flow and currencies",
    async () => {
      const before = await overview("2026-10", "EUR");
      const records = [
        bank("capital-invest", "100.00", "Lightyear EU Client Money"),
        bank("capital-pension", "50.00", "AS PENSIONIKESKUS"),
        bank(
          "capital-salary",
          "20.00",
          "Lightyear Financial Ltd Salary",
          "EUR",
          "CRDT",
        ),
      ];
      await transaction((db) =>
        importBankTransactions(account.id, records, db),
      );
      await transaction((db) =>
        importBankTransactions(
          usd.id,
          [bank("capital-usd", "30.00", "Lightyear", "USD")],
          db,
        ),
      );
      const after = await overview("2026-10", "EUR");
      assert.equal(after.spending, before.spending);
      assert.equal(after.expense_count, before.expense_count);
      assert.equal(after.income, before.income + 2000);
      assert.equal(after.net_cash_flow, before.net_cash_flow - 13000);
      assert.equal(after.investment.contributed, 10000);
      assert.equal(after.pension.contributed, 5000);
      assert.equal(after.trend.at(-1)!.investment, 10000);
      assert.equal(after.trend.at(-1)!.pension, 5000);
      assert.equal(
        (await overview("2026-10", "USD")).investment.contributed,
        3000,
      );
      assert.equal(
        after.categories.some((c) => ["investments", "pension"].includes(c.id)),
        false,
      );
      await transaction((db) =>
        importBankTransactions(account.id, records, db),
      );
      assert.equal(
        (await overview("2026-10", "EUR")).investment.contributed,
        10000,
      );
      const [entry] = await query(
        "SELECT id FROM transactions WHERE source_key='ref:capital-invest'",
      );
      await query(
        "UPDATE transactions SET manual=true,kind='pension' WHERE id=$1",
        [entry.id],
      );
      await query(
        "UPDATE allocations SET category_id='pension' WHERE transaction_id=$1",
        [entry.id],
      );
      await transaction((db) =>
        importBankTransactions(
          account.id,
          [bank("capital-invest", "101.00", "Lightyear")],
          db,
        ),
      );
      await transaction((db) => reclassify(db));
      assert.equal(
        (
          await query("SELECT kind FROM transactions WHERE id=$1", [entry.id])
        )[0].kind,
        "pension",
      );
      assert.equal(
        (
          await query(
            "SELECT amount FROM allocations WHERE transaction_id=$1",
            [entry.id],
          )
        )[0].amount,
        10100,
      );
    },
  );
  await check(
    "contribution history stops at the selected month and excludes pending payments",
    async () => {
      const before = await overview("2026-10", "EUR");
      await transaction((db) =>
        importBankTransactions(
          account.id,
          [
            {
              ...bank("capital-history", "40.00", "Lightyear"),
              booking_date: "2026-09-01",
            },
            {
              ...bank("capital-future", "60.00", "Lightyear"),
              booking_date: "2026-11-01",
            },
            {
              ...bank("capital-pending", "80.00", "Lightyear"),
              status: "PDNG",
            },
            bank("capital-return", "25.00", "Broker withdrawal", "EUR", "CRDT"),
          ],
          db,
        ),
      );
      const [returned] = await query(
        "SELECT id FROM transactions WHERE source_key='ref:capital-return'",
      );
      await query(
        "UPDATE transactions SET kind='investment',manual=true WHERE id=$1",
        [returned.id],
      );
      await query(
        "INSERT INTO allocations VALUES($1,'investments',-2500,'manual')",
        [returned.id],
      );
      const after = await overview("2026-10", "EUR");
      assert.equal(after.investment.contributed, before.investment.contributed);
      assert.equal(
        after.investment.withdrawn,
        before.investment.withdrawn + 2500,
      );
      assert.equal(after.investment.net, before.investment.net - 2500);
      assert.equal(
        after.investment.history_contributed,
        before.investment.history_contributed + 4000,
      );
      assert.equal(
        after.investment.history_withdrawn,
        before.investment.history_withdrawn + 2500,
      );
      assert.equal(after.net_cash_flow, before.net_cash_flow + 2500);
      assert.equal(after.income, before.income);
      assert.equal(after.spending, before.spending);
      const empty = await overview("2027-01", "EUR");
      assert.equal(empty.investment.contributed, 0);
      assert.equal(
        empty.investment.history_contributed,
        after.investment.history_contributed + 6000,
      );
    },
  );
  await check(
    "contribution rules classify outgoing own-account transfers and disabling them restores transfers",
    async () => {
      const raw = {
        ...bank("capital-rule", "8.00", "My broker account"),
        creditor_account: { iban: "EEOWNER" },
      };
      await transaction((db) => importBankTransactions(account.id, [raw], db));
      const [entry] = await query(
        "SELECT id,kind FROM transactions WHERE source_key='ref:capital-rule'",
      );
      assert.equal(entry.kind, "transfer");
      const [rule] = await query(
        "INSERT INTO rules(field,pattern,category_id) VALUES('merchant','My broker account','investments') RETURNING id",
      );
      await transaction((db) => reclassify(db));
      assert.equal(
        (
          await query("SELECT kind FROM transactions WHERE id=$1", [entry.id])
        )[0].kind,
        "investment",
      );
      await query("UPDATE rules SET enabled=false WHERE id=$1", [rule.id]);
      await transaction((db) => reclassify(db));
      assert.equal(
        (
          await query("SELECT kind FROM transactions WHERE id=$1", [entry.id])
        )[0].kind,
        "transfer",
      );
      assert.equal(
        (
          await query(
            "SELECT count(*)::int AS n FROM allocations WHERE transaction_id=$1",
            [entry.id],
          )
        )[0].n,
        0,
      );
    },
  );
  await check(
    "split payments enforce both receipt and transaction limits",
    async () => {
      const receipt = await storeReceipt(
        Buffer.from(receiptText("Selver", "split")),
        "split.txt",
      );
      await processReceipt(receipt.id);
      await transaction((db) =>
        importBankTransactions(
          account.id,
          [bank("split1", "2.00", "Selver"), bank("split2", "3.10", "Selver")],
          db,
        ),
      );
      const entries = await query(
        "SELECT id,amount FROM transactions WHERE source_key IN ('ref:split1','ref:split2') ORDER BY amount DESC",
      );
      await transaction(async (db) => {
        for (const entry of entries)
          await linkReceipt(receipt.id, entry.id, -entry.amount, false, db);
      });
      await assert.rejects(
        transaction((db) =>
          linkReceipt(receipt.id, entries[0].id, 500, false, db),
        ),
      );
      assert.equal(
        (
          await query(
            "SELECT sum(amount)::bigint AS amount FROM receipt_payments WHERE receipt_id=$1",
            [receipt.id],
          )
        )[0].amount,
        510,
      );
    },
  );
  await check("real PDF extraction reaches the receipt parser", async () => {
    const pdf = textPdf(receiptText("Lidl", "pdf"));
    const text = await extractDocument(pdf, "application/pdf");
    assert.match(text, /Lidl/);
    const receipt = await storeReceipt(pdf, "lidl.pdf");
    await processReceipt(receipt.id);
    assert.equal(
      (await query("SELECT total FROM receipts WHERE id=$1", [receipt.id]))[0]
        .total,
      510,
    );
  });
  await check(
    "forwarding verification preserves the message without importing receipts",
    async () => {
      const raw = Buffer.from(
        "From: forwarding-noreply@google.com\r\nSubject: Gmail Forwarding Confirmation\r\nContent-Type: text/plain\r\n\r\nConfirmation code: 012345678\nhttps://mail.google.com/mail/vf-test-token",
      );
      const before = (
        await query("SELECT count(*)::int AS count FROM receipts")
      )[0].count;
      const email = await receiveEmail(raw);
      await processEmail(email.id);
      await processEmail(email.id);
      assert.deepEqual(
        (
          await query(
            "SELECT status,error,receipt_ids FROM inbound_emails WHERE id=$1",
            [email.id],
          )
        )[0],
        {
          status: "verification",
          error: null,
          receipt_ids: [],
        },
      );
      assert.equal(
        (await query("SELECT count(*)::int AS count FROM receipts"))[0].count,
        before,
      );
      assert.deepEqual(await receiveEmail(raw), {
        id: email.id,
        status: "verification",
      });
      assert.deepEqual((await readEmailMessage(email.id)).verification, {
        code: "012345678",
        url: "https://mail.google.com/mail/vf-test-token",
      });
    },
  );
  await check("forwarded MIME bodies import idempotently", async () => {
    const raw = Buffer.from(
      `From: receipts@example.com\r\nTo: me@example.com\r\nSubject: Rimi receipt\r\nMessage-ID: <fixture@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${receiptText("Rimi", "email")}`,
    );
    const email = await receiveEmail(raw);
    await processEmail(email.id);
    assert.equal((await receiveEmail(raw)).id, email.id);
    assert.equal(
      (
        await query("SELECT status FROM inbound_emails WHERE id=$1", [email.id])
      )[0].status,
      "complete",
    );
  });
  await check(
    "Rimi review receipts reprocess, match once and preserve product corrections without changing spending",
    async () => {
      await transaction((db) =>
        importBankTransactions(account.id, [bank("rimi-recovery", "6.00")], db),
      );
      const text = `Rimi
Digitaalne tiekk
KLIENT: TEST
Test protein bar
2,000 tk. X 3,19 5,38 A
Allah. -1,60 Üus hind 4,78
Test banana
0,300kg X 1,29EUR/kg 0,39 A
Test lemonade 0,51
pdl 1,23 A
Metallist ühekorrapakend 0,10 E
SINU SOODUSTUSED:
Kampaania -1,60
Kasutatud Sinu RIMI raha -0,50
KAARDIMAKSE
SUMMA: 6,00 EUR
KOKKU 56, 00 EUR
KAARDIMAKSE 6,00 EUR
ARVE NR: RECOVERY-1001
KUUPÄEV: 02.10.2026`;
      const receipt = await storeReceipt(
        Buffer.from(text),
        "rimi-recovery.txt",
      );
      await query(
        "UPDATE receipts SET status='review',issues='[\"Previous parser could not reconcile\"]' WHERE id=$1",
        [receipt.id],
      );
      const before = await overview("2026-10", "EUR");
      await processReceipt(receipt.id);
      let detail = await receiptDetail(receipt.id);
      const [parsedReceipt] = await query(
        "SELECT status,total,issues FROM receipts WHERE id=$1",
        [receipt.id],
      );
      assert.equal(parsedReceipt.status, "matched");
      assert.equal(parsedReceipt.total, 600);
      assert.deepEqual(parsedReceipt.issues, []);
      assert.equal(detail.items.length, 4);
      assert.equal(
        detail.items.reduce((sum, item) => sum + item.amount, 0),
        600,
      );
      assert.equal(detail.items[3].amount, 10);
      await query(
        "UPDATE receipt_items SET category_id='household',manual=true WHERE id=$1",
        [detail.items[0].id],
      );
      await processReceipt(receipt.id);
      detail = await receiptDetail(receipt.id);
      assert.equal(detail.links.length, 1);
      assert.equal(detail.items[0].category_id, "household");
      assert.equal(detail.items[0].manual, true);
      assert.equal(
        (await storeReceipt(Buffer.from(text), "rimi-recovery-again.txt")).id,
        receipt.id,
      );
      assert.equal(
        (await overview("2026-10", "EUR")).spending,
        before.spending,
      );
      // A forwarded Rimi logo can have attachment disposition despite its
      // "inline" name. Preserve the actual PDF and omit that branding image.
      const pdf = textPdf(text.replace("RECOVERY-1001", "RECOVERY-LOGO-1001"));
      const mime = Buffer.from(
        [
          "From: receipts@example.com",
          "To: me@example.com",
          "Subject: Rimi logo regression",
          'Content-Type: multipart/mixed; boundary="rimi-logo"',
          "",
          "--rimi-logo",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Your Rimi receipt is attached.",
          "--rimi-logo",
          'Content-Type: image/jpeg; name="inline"',
          'Content-Disposition: attachment; filename="inline"',
          "Content-Transfer-Encoding: base64",
          "",
          Buffer.from([255, 216, 255, 217]).toString("base64"),
          "--rimi-logo",
          'Content-Type: application/pdf; name="rimi.pdf"',
          'Content-Disposition: attachment; filename="rimi.pdf"',
          "Content-Transfer-Encoding: base64",
          "",
          pdf.toString("base64"),
          "--rimi-logo--",
          "",
        ].join("\r\n"),
      );
      const email = await receiveEmail(mime);
      await processEmail(email.id);
      const [inbound] = await query(
        "SELECT status,receipt_ids FROM inbound_emails WHERE id=$1",
        [email.id],
      );
      assert.equal(inbound.status, "complete");
      assert.equal(inbound.receipt_ids.length, 1);
      const [attachment] = await query(
        "SELECT filename FROM receipts WHERE id=$1",
        [inbound.receipt_ids[0]],
      );
      assert.equal(attachment.filename, "rimi.pdf");
    },
  );
  await check(
    "Coop PDFs preserve product quantities and repeated deposits, match Konsum payments, and deduplicate",
    async () => {
      await transaction((db) =>
        importBankTransactions(
          account.id,
          [
            {
              ...bank("coop-pdf", "5.67", "TEST KONSUM"),
              booking_date: "2026-10-03",
            },
          ],
          db,
        ),
      );
      const buffer = textPdf(coopReceiptText);
      const receipt = await storeReceipt(buffer, "coop.pdf");
      await processReceipt(receipt.id);
      const [parsed] = await query(
        "SELECT retailer,status,total,card_amount,receipt_number,purchased_at FROM receipts WHERE id=$1",
        [receipt.id],
      );
      assert.deepEqual(parsed, {
        retailer: "coop",
        status: "matched",
        total: 567,
        card_amount: 567,
        receipt_number: "COOP-TEST-1001",
        purchased_at: "2026-10-03",
      });
      const items = await query(
        "SELECT amount,quantity,category_id FROM receipt_items WHERE receipt_id=$1 ORDER BY position",
        [receipt.id],
      );
      assert.deepEqual(
        items.map((item) => item.amount),
        [279, 149, 10, 119, 10],
      );
      assert.equal(
        items.every((item) => item.quantity === "1"),
        true,
      );
      const allocations = await query(
        "SELECT a.category_id,a.amount FROM allocations a JOIN receipt_payments p ON p.transaction_id=a.transaction_id WHERE p.receipt_id=$1 ORDER BY a.category_id",
        [receipt.id],
      );
      assert.deepEqual(allocations, [
        { category_id: "deposits", amount: 20 },
        { category_id: "groceries", amount: 547 },
      ]);
      assert.equal(
        (await storeReceipt(buffer, "same-coop.pdf")).id,
        receipt.id,
      );
      await processReceipt(receipt.id);
      assert.equal(
        (
          await query(
            "SELECT count(*)::int AS n FROM receipt_payments WHERE receipt_id=$1",
            [receipt.id],
          )
        )[0].n,
        1,
      );
    },
  );
  await check(
    "Selver CSV uploads and named/unnamed email attachments share one receipt",
    async () => {
      const csv = Buffer.from(selverCsv);
      const uploaded = await storeReceipt(csv, "receipt-different-number.csv");
      await processReceipt(uploaded.id);
      const [receipt] = await query(
        "SELECT status,total,card_amount,receipt_number,purchased_at,content_type FROM receipts WHERE id=$1",
        [uploaded.id],
      );
      assert.equal(receipt.status, "ready");
      assert.equal(receipt.total, 963);
      assert.equal(receipt.card_amount, 963);
      assert.equal(receipt.receipt_number, "CSV-1001");
      assert.equal(receipt.purchased_at, "2026-09-28");
      assert.equal(receipt.content_type, "text/csv");
      const products = await query(
        "SELECT description,quantity,unit,amount FROM receipt_items WHERE receipt_id=$1 ORDER BY position",
        [uploaded.id],
      );
      assert.equal(products.length, 5);
      assert.equal(products[1].quantity, "0.228");
      assert.equal(products[1].unit, null);
      assert.equal(products[2].description, products[3].description);
      const mime = Buffer.from(
        `From: receipts@example.com\r\nTo: me@example.com\r\nSubject: Selver CSV\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=csv-fixture\r\n\r\n--csv-fixture\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="selver.csv"\r\nContent-Transfer-Encoding: base64\r\n\r\n${csv.toString("base64")}\r\n--csv-fixture\r\nContent-Type: text/csv\r\nContent-Disposition: attachment\r\nContent-Transfer-Encoding: base64\r\n\r\n${csv.toString("base64")}\r\n--csv-fixture--\r\n`,
      );
      const email = await receiveEmail(mime);
      await processEmail(email.id);
      const [message] = await query(
        "SELECT status,receipt_ids FROM inbound_emails WHERE id=$1",
        [email.id],
      );
      assert.equal(message.status, "complete");
      assert.deepEqual(message.receipt_ids, [uploaded.id]);
      assert.equal((await storeReceipt(csv, "repeat.csv")).id, uploaded.id);
    },
  );
  await check(
    "Wolt email documents reconcile to one bank payment without duplicate spending",
    async () => {
      await transaction((db) =>
        importBankTransactions(
          account.id,
          [bank("wolt-order", "7.40", "Wolt")],
          db,
        ),
      );
      const food = textPdf(woltReceiptText());
      const uploaded = await storeReceipt(food, "wolt-food.pdf");
      await processReceipt(uploaded.id);
      const mime = Buffer.from(
        [
          "From: info@wolt.com",
          "To: me@example.com",
          "Subject: Wolt receipt",
          "MIME-Version: 1.0",
          "Content-Type: multipart/mixed; boundary=wolt-test",
          "",
          "--wolt-test",
          "Content-Type: text/plain",
          "",
          `Wolt\nOrder ID: ${woltOrderId}\nTotal EUR 7.40`,
          ...[food, textPdf(woltReceiptText(true))].flatMap((pdf, index) => [
            "--wolt-test",
            "Content-Type: application/pdf",
            `Content-Disposition: attachment; filename="wolt-${index}.pdf"`,
            "Content-Transfer-Encoding: base64",
            "",
            pdf.toString("base64"),
          ]),
          "--wolt-test--",
          "",
        ].join("\r\n"),
      );
      const email = await receiveEmail(mime);
      await processEmail(email.id);
      const [message] = await query(
        "SELECT status,receipt_ids FROM inbound_emails WHERE id=$1",
        [email.id],
      );
      assert.equal(message.status, "complete");
      assert.equal(message.receipt_ids.length, 2);
      assert.equal(message.receipt_ids[0], uploaded.id);
      await processReceipt(message.receipt_ids[0]);
      assert.equal(
        (
          await query(
            "SELECT count(*)::int AS n FROM receipt_payments WHERE receipt_id=ANY($1::uuid[])",
            [message.receipt_ids],
          )
        )[0].n,
        0,
      );
      await processReceipt(message.receipt_ids[1]);
      const links = await query(
        "SELECT transaction_id,amount FROM receipt_payments WHERE receipt_id=ANY($1::uuid[]) ORDER BY amount",
        [message.receipt_ids],
      );
      assert.deepEqual(
        links.map((link) => link.amount),
        [140, 600],
      );
      assert.equal(links[0].transaction_id, links[1].transaction_id);
      const allocations = await query(
        "SELECT category_id,amount FROM allocations WHERE transaction_id=$1",
        [links[0].transaction_id],
      );
      assert.deepEqual(allocations, [
        { category_id: "restaurants", amount: 740 },
      ]);
      assert.equal((await receiveEmail(mime)).id, email.id);
      for (const id of message.receipt_ids) await processReceipt(id);
      assert.equal(
        (
          await query(
            "SELECT count(*)::int AS n FROM receipt_payments WHERE receipt_id=ANY($1::uuid[])",
            [message.receipt_ids],
          )
        )[0].n,
        2,
      );
    },
  );
  await check(
    "incomplete Wolt orders cannot match a subtotal payment",
    async () => {
      const id = "123456789abcdef012345678";
      await transaction((db) =>
        importBankTransactions(
          account.id,
          [bank("wolt-subtotal", "6.00", "Wolt")],
          db,
        ),
      );
      const receipt = await storeReceipt(
        textPdf(woltReceiptText(false, id)),
        "incomplete-wolt.pdf",
        "wolt",
        "email",
        { orderId: id, total: 740, currency: "EUR" },
      );
      await processReceipt(receipt.id);
      assert.equal(
        (
          await query("SELECT status FROM receipts WHERE id=$1", [receipt.id])
        )[0].status,
        "ready",
      );
      assert.equal(
        (
          await query(
            "SELECT count(*)::int AS n FROM receipt_payments WHERE receipt_id=$1",
            [receipt.id],
          )
        )[0].n,
        0,
      );
    },
  );
  await check(
    "Lidl PNGs use local OCR and preserve products and discounts",
    async () => {
      const { createCanvas } = await import("@napi-rs/canvas");
      const lines = lidlReceiptText
        .replace("x | tk", "x 1 tk")
        .replace("Tšeki", "Tseki")
        .split("\n");
      const canvas = createCanvas(1100, lines.length * 55 + 60),
        context = canvas.getContext("2d");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#000";
      context.font = "30px monospace";
      lines.forEach((line, index) =>
        context.fillText(line, 30, 50 + index * 55),
      );
      const receipt = await storeReceipt(
        canvas.toBuffer("image/png"),
        "lidl.png",
      );
      await processReceipt(receipt.id);
      const [parsed] = await query(
        "SELECT status,total,card_amount,receipt_number FROM receipts WHERE id=$1",
        [receipt.id],
      );
      assert.deepEqual(parsed, {
        status: "ready",
        total: 293,
        card_amount: 293,
        receipt_number: "TEST-LIDL-1001",
      });
      const items = await query(
        "SELECT amount FROM receipt_items WHERE receipt_id=$1 ORDER BY position",
        [receipt.id],
      );
      assert.deepEqual(
        items.map((item) => item.amount),
        [29, 89, -24, 93, -29, 135],
      );
    },
  );
  await check(
    "emailed image-only PDFs render, reconcile, and deduplicate",
    async () => {
      const { createCanvas } = await import("@napi-rs/canvas");
      const lines = [
        "Rimi",
        "Digitaalne tsekk",
        "KLIENT: TEST",
        "Milk",
        "2,000 tk. X 1,00 2,00 A",
        "Allah. -0,20 Uus hind 1,80",
        "SINU SOODUSTUSED:",
        "Kampaania -0,20",
        "Oled saastnud 0,20",
        "KOKKU 1,80 EUR",
        "KAARDIMAKSE 1,80 EUR",
        "KASSA: 0001 ARVE NR: SCAN-1001",
        "KUUPAEV: 02.10.2026",
      ];
      const canvas = createCanvas(900, 1100);
      const context = canvas.getContext("2d");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#000";
      context.font = "30px monospace";
      lines.forEach((line, index) =>
        context.fillText(line, 30, 65 + index * 65),
      );
      const pdf = scannedPdf(
        canvas.width,
        canvas.height,
        context.getImageData(0, 0, canvas.width, canvas.height).data,
      );
      const mime = Buffer.from(
        `From: receipts@example.com\r\nTo: me@example.com\r\nSubject: Rimi PDF\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=scan-fixture\r\n\r\n--scan-fixture\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="scan.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${pdf
          .toString("base64")
          .match(/.{1,76}/g)!
          .join("\r\n")}\r\n--scan-fixture--\r\n`,
      );
      const email = await receiveEmail(mime);
      await processEmail(email.id);
      const [message] = await query(
        "SELECT status,receipt_ids FROM inbound_emails WHERE id=$1",
        [email.id],
      );
      assert.equal(message.status, "complete");
      assert.equal(message.receipt_ids.length, 1);
      const id = message.receipt_ids[0];
      await processReceipt(id);
      const [parsed] = await query(
        "SELECT status,total,card_amount,receipt_number FROM receipts WHERE id=$1",
        [id],
      );
      assert.equal(parsed.status, "ready");
      assert.equal(parsed.total, 180);
      assert.equal(parsed.card_amount, 180);
      assert.equal(parsed.receipt_number, "SCAN-1001");
      const [item] = await query(
        "SELECT description,quantity,unit,amount FROM receipt_items WHERE receipt_id=$1",
        [id],
      );
      assert.equal(item.description, "Milk");
      assert.equal(item.quantity, "2.000");
      assert.equal(item.unit, "tk");
      assert.equal(item.amount, 180);
      assert.equal((await receiveEmail(mime)).id, email.id);
      assert.equal((await storeReceipt(pdf, "same-scan.pdf")).id, id);
    },
  );
  await check(
    "image OCR recognizes and validates a synthetic receipt locally",
    async () => {
      const { createCanvas } = await import("@napi-rs/canvas");
      const canvas = createCanvas(850, 800),
        context = canvas.getContext("2d");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, 850, 800);
      context.fillStyle = "#000";
      context.font = "30px monospace";
      receiptText("Rimi", "OCR-001")
        .split("\n")
        .slice(0, 8)
        .forEach((line, index) => context.fillText(line, 40, 60 + index * 60));
      const receipt = await storeReceipt(
        canvas.toBuffer("image/png"),
        "ocr.png",
      );
      await processReceipt(receipt.id);
      const [parsed] = await query(
        "SELECT total,status FROM receipts WHERE id=$1",
        [receipt.id],
      );
      assert.equal(parsed.total, 510);
      assert.equal(parsed.status, "ready");
    },
  );
  await check(
    "pending payments are selectable and explicit receipt links move to a uniquely booked payment",
    async () => {
      const raw = {
        ...bank("receipt-pending", "5.10"),
        status: "PDNG",
        creditor: {},
        debtor: {},
        remittance_information: ["TEST KONSUM"],
      };
      await transaction((db) => importBankTransactions(account.id, [raw], db));
      const [pending] = await query(
        "SELECT id,merchant FROM transactions WHERE source_key='ref:receipt-pending'",
      );
      assert.equal(pending.merchant, "TEST KONSUM");
      const receipt = await storeReceipt(
        Buffer.from(receiptText("Coop", "PENDING-LINK-TEST")),
        "pending-coop.txt",
      );
      await processReceipt(receipt.id);
      const before = await overview("2026-10", "EUR");
      const detail = await receiptDetail(receipt.id);
      assert.equal(
        detail.candidates.find((c) => c.id === pending.id)?.status,
        "PDNG",
      );
      await assert.rejects(
        transaction((db) => linkReceipt(receipt.id, pending.id, 510, true, db)),
      );
      await transaction((db) =>
        linkReceipt(receipt.id, pending.id, 510, false, db),
      );
      assert.equal((await receiptDetail(receipt.id)).links[0].status, "PDNG");
      assert.equal(
        (await overview("2026-10", "EUR")).spending,
        before.spending,
      );
      const booked = {
        ...bank("receipt-booked", "5.10", "TEST KONSUM"),
        booking_date: "2026-10-03",
      };
      await transaction((db) =>
        importBankTransactions(account.id, [booked], db),
      );
      const linked = await receiptDetail(receipt.id);
      assert.equal(linked.links.length, 1);
      assert.equal(linked.links[0].status, "BOOK");
      assert.notEqual(linked.links[0].transaction_id, pending.id);
      assert.equal(
        (
          await query("SELECT status FROM transactions WHERE id=$1", [
            pending.id,
          ])
        )[0].status,
        "SUPERSEDED",
      );
      assert.equal(
        (await overview("2026-10", "EUR")).spending,
        before.spending + 510,
      );
      await transaction((db) =>
        importBankTransactions(account.id, [booked], db),
      );
      assert.equal((await receiptDetail(receipt.id)).links.length, 1);
    },
  );
  await check(
    "two identical booked payments do not claim one pending receipt",
    async () => {
      await transaction((db) =>
        importBankTransactions(
          account.id,
          [
            {
              ...bank("ambiguous-pending", "5.10", "TEST AMBIGUOUS SHOP"),
              status: "PDNG",
            },
          ],
          db,
        ),
      );
      const [pending] = await query(
        "SELECT id FROM transactions WHERE source_key='ref:ambiguous-pending'",
      );
      const receipt = await storeReceipt(
        Buffer.from(receiptText("Coop", "AMBIGUOUS-PENDING-LINK")),
        "ambiguous-pending.txt",
      );
      await processReceipt(receipt.id);
      await transaction((db) =>
        linkReceipt(receipt.id, pending.id, 510, false, db),
      );
      await transaction((db) =>
        importBankTransactions(
          account.id,
          [
            bank("ambiguous-booked-1", "5.10", "TEST AMBIGUOUS SHOP"),
            bank("ambiguous-booked-2", "5.10", "TEST AMBIGUOUS SHOP"),
          ],
          db,
        ),
      );
      const detail = await receiptDetail(receipt.id);
      assert.equal(detail.links[0].transaction_id, pending.id);
      assert.equal(detail.links[0].status, "PDNG");
      assert.equal(
        (
          await query("SELECT status FROM transactions WHERE id=$1", [
            pending.id,
          ])
        )[0].status,
        "PDNG",
      );
    },
  );
  await check(
    "settling a pending payment preserves manual categories and notes",
    async () => {
      await transaction((db) =>
        importBankTransactions(
          account.id,
          [
            {
              ...bank("manual-pending", "3.00", "TEST OWNER SHOP"),
              status: "PDNG",
            },
          ],
          db,
        ),
      );
      const [pending] = await query(
        "SELECT id FROM transactions WHERE source_key='ref:manual-pending'",
      );
      await query(
        "UPDATE transactions SET manual=true,note='Owner correction' WHERE id=$1",
        [pending.id],
      );
      await query(
        "UPDATE allocations SET category_id='gifts',source='manual' WHERE transaction_id=$1",
        [pending.id],
      );
      await transaction((db) =>
        importBankTransactions(
          account.id,
          [bank("manual-settled", "3.00", "TEST OWNER SHOP")],
          db,
        ),
      );
      const [booked] = await query(
        "SELECT id,manual,note FROM transactions WHERE source_key='ref:manual-settled'",
      );
      assert.equal(booked.manual, true);
      assert.equal(booked.note, "Owner correction");
      assert.deepEqual(
        await query(
          "SELECT category_id,amount FROM allocations WHERE transaction_id=$1",
          [booked.id],
        ),
        [{ category_id: "gifts", amount: 300 }],
      );
    },
  );
  await check(
    "bank pages repeat pending lists without multiplying identical purchases",
    async () => {
      const [connection] = await query(
        "INSERT INTO bank_connections(bank_name,country,session_cipher,valid_until) VALUES('SEB','EE',$1,now()+interval '30 days') RETURNING id",
        [encrypt({ id: "pending-test" })],
      );
      const [wallet] = await query(
        "INSERT INTO accounts(connection_id,identification_hash,provider_uid,name,currency) VALUES($1,'pending-pages','pending-pages','Pending test wallet','EUR') RETURNING id",
        [connection.id],
      );
      const pending = {
        ...bank(undefined, "6.12", "TEST PENDING SHOP"),
        transaction_id: undefined,
        status: "PDNG",
      };
      // Simulate a prior importer that multiplied one page's two genuine purchases by two pages.
      await transaction((db) =>
        importBankTransactions(
          wallet.id,
          [pending, pending, pending, pending],
          db,
        ),
      );
      const original = globalThis.fetch;
      try {
        globalThis.fetch = async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/balances"))
            return Response.json({ balances: [] });
          return Response.json({
            transactions: [pending, pending],
            ...(url.searchParams.has("continuation_key")
              ? {}
              : { continuation_key: "second" }),
          });
        };
        await syncBank(connection.id);
        assert.equal(
          (
            await query(
              "SELECT count(*)::int AS n FROM transactions WHERE account_id=$1 AND status='PDNG'",
              [wallet.id],
            )
          )[0].n,
          2,
        );
        await syncBank(connection.id);
        assert.equal(
          (
            await query(
              "SELECT count(*)::int AS n FROM transactions WHERE account_id=$1 AND status='PDNG'",
              [wallet.id],
            )
          )[0].n,
          2,
        );
        await query(
          "UPDATE bank_connections SET bank_name='Other bank' WHERE id=$1",
          [connection.id],
        );
        await syncBank(connection.id);
        assert.equal(
          (
            await query(
              "SELECT count(*)::int AS n FROM transactions WHERE account_id=$1 AND status='PDNG'",
              [wallet.id],
            )
          )[0].n,
          4,
        );
      } finally {
        globalThis.fetch = original;
      }
    },
  );
  await check(
    "SEB snapshots retire vanished pending copies only after complete pagination and protect owner data",
    async () => {
      const [connection] = await query(
        "INSERT INTO bank_connections(bank_name,country,session_cipher,valid_until) VALUES('SEB','LT',$1,now()+interval '30 days') RETURNING id",
        [encrypt({ id: "stale-pending-test" })],
      );
      const [wallet] = await query(
        "INSERT INTO accounts(connection_id,identification_hash,provider_uid,name,currency,last_sync_at) VALUES($1,'stale-pending','stale-pending','Stale pending wallet','EUR',now()) RETURNING id",
        [connection.id],
      );
      const pending = (merchant: string, amount = "10.00") => ({
        ...bank(undefined, amount, merchant),
        status: "PDNG",
        transaction_id: undefined,
        creditor: {},
        debtor: {},
        remittance_information: [merchant],
      });
      const stale = pending("Revolut**6902*"),
        current = pending("TEST CURRENT PENDING", "6.12"),
        manual = pending("TEST MANUAL PENDING", "4.10"),
        linked = pending("TEST LINKED PENDING", "5.10"),
        historical = {
          ...pending("TEST OLDER PENDING", "1.23"),
          booking_date: "2024-10-02",
        },
        booked = {
          ...bank("snapshot-revolut-booked", "10.00", "Revolut**6902*"),
          booking_date: "2026-10-03",
        };
      await transaction((db) =>
        importBankTransactions(
          wallet.id,
          [
            ...Array(5).fill(stale),
            ...Array(3).fill(current),
            manual,
            linked,
            historical,
          ],
          db,
        ),
      );
      await query(
        "UPDATE transactions SET manual=true,note='Keep owner correction' WHERE account_id=$1 AND fingerprint=$2",
        [wallet.id, bankFingerprint(manual)],
      );
      const [predecessor] = await query(
        "SELECT id FROM transactions WHERE account_id=$1 AND fingerprint=$2",
        [wallet.id, bankFingerprint(linked)],
      );
      const receipt = await storeReceipt(
        Buffer.from(receiptText("Rimi", "SNAPSHOT-PROTECTED-LINK")),
        "snapshot-protected.txt",
      );
      await processReceipt(receipt.id);
      await transaction((db) =>
        linkReceipt(receipt.id, predecessor.id, 510, false, db),
      );
      const original = globalThis.fetch;
      try {
        // An incomplete fetch must leave the entire prior snapshot untouched.
        globalThis.fetch = async (input) => {
          const url = new URL(String(input));
          return url.searchParams.has("continuation_key")
            ? Response.json({ error: "TEMPORARY_ERROR" }, { status: 500 })
            : Response.json({
                transactions: [current, booked],
                continuation_key: "failed-page",
              });
        };
        await assert.rejects(syncBank(connection.id));
        assert.equal(
          (
            await query(
              "SELECT count(*)::int AS n FROM transactions WHERE account_id=$1 AND status='PDNG'",
              [wallet.id],
            )
          )[0].n,
          11,
        );
        assert.equal(
          (
            await query(
              "SELECT count(*)::int AS n FROM transactions WHERE account_id=$1 AND status='BOOK'",
              [wallet.id],
            )
          )[0].n,
          0,
        );
        // A single successful page is sufficient; stale copies need not appear
        // again on multiple pages for the cleanup to apply.
        globalThis.fetch = async (input) =>
          Response.json(
            new URL(String(input)).pathname.endsWith("/balances")
              ? { balances: [] }
              : { transactions: [current, booked] },
          );
        await syncBank(connection.id);
        assert.equal(
          (
            await query(
              "SELECT count(*)::int AS n FROM transactions WHERE account_id=$1 AND fingerprint=$2 AND status='SUPERSEDED'",
              [wallet.id, bankFingerprint(stale)],
            )
          )[0].n,
          5,
        );
        assert.equal(
          (
            await query(
              "SELECT count(*)::int AS n FROM transactions WHERE account_id=$1 AND status='PDNG'",
              [wallet.id],
            )
          )[0].n,
          4,
        );
        const [correction] = await query(
          "SELECT status,note FROM transactions WHERE account_id=$1 AND fingerprint=$2",
          [wallet.id, bankFingerprint(manual)],
        );
        assert.deepEqual(correction, {
          status: "PDNG",
          note: "Keep owner correction",
        });
        assert.equal(
          (await receiptDetail(receipt.id)).links[0].transaction_id,
          predecessor.id,
        );
        assert.equal(
          (
            await query(
              "SELECT count(*)::int AS n FROM transaction_revisions r JOIN transactions t ON t.id=r.transaction_id WHERE t.account_id=$1 AND t.fingerprint=$2",
              [wallet.id, bankFingerprint(stale)],
            )
          )[0].n,
          5,
        );
        // An empty completed snapshot clears only the remaining unprotected
        // pending row inside the sync window.
        globalThis.fetch = async () =>
          Response.json({ transactions: [], balances: [] });
        await syncBank(connection.id);
        assert.equal(
          (
            await query(
              "SELECT count(*)::int AS n FROM transactions WHERE account_id=$1 AND status='PDNG'",
              [wallet.id],
            )
          )[0].n,
          3,
        );
      } finally {
        globalThis.fetch = original;
      }
    },
  );
  await check(
    "bank pagination follows empty pages and commits only complete history",
    async () => {
      const [connection] = await query(
        "INSERT INTO bank_connections(bank_name,country,session_cipher,valid_until) VALUES('Test bank','EE',$1,now()+interval '30 days') RETURNING id",
        [encrypt({ id: "test-session" })],
      );
      await query(
        "UPDATE accounts SET connection_id=$1,provider_uid='test-wallet' WHERE id=$2",
        [connection.id, account.id],
      );
      const originalFetch = globalThis.fetch;
      const calls: URL[] = [];
      try {
        globalThis.fetch = async (input) => {
          const url = new URL(String(input));
          assert.equal(url.hostname, "api.enablebanking.com");
          calls.push(url);
          if (url.pathname.endsWith("/balances"))
            return Response.json({ balances: [] });
          if (!url.searchParams.has("continuation_key"))
            return Response.json({
              transactions: [],
              continuation_key: "next-page",
            });
          return Response.json({
            transactions: [bank("paged", "0.01", "Coop")],
          });
        };
        await syncBank(connection.id);
        assert.equal(
          calls.filter((url) => url.pathname.endsWith("/transactions")).length,
          2,
        );
        const first = calls[0].searchParams,
          second = calls[1].searchParams;
        assert.equal(first.get("strategy"), "longest");
        assert.equal(second.get("strategy"), "longest");
        const [checkpoint] = await query(
          "SELECT last_sync_at FROM accounts WHERE id=$1",
          [account.id],
        );
        globalThis.fetch = async (input) => {
          const url = new URL(String(input));
          return url.searchParams.has("continuation_key")
            ? Response.json({ error: "TEMPORARY_ERROR" }, { status: 500 })
            : Response.json({
                transactions: [bank("incomplete", "0.01", "Coop")],
                continuation_key: "failure",
              });
        };
        await assert.rejects(syncBank(connection.id));
        assert.equal(
          (
            await query(
              "SELECT count(*)::int AS n FROM transactions WHERE source_key='ref:incomplete'",
            )
          )[0].n,
          0,
        );
        assert.equal(
          new Date(
            (
              await query("SELECT last_sync_at FROM accounts WHERE id=$1", [
                account.id,
              ])
            )[0].last_sync_at,
          ).valueOf(),
          new Date(checkpoint.last_sync_at).valueOf(),
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
  await check(
    "renewed bank consent retains stable currency wallets and rejects state replay",
    async () => {
      const originalFetch = globalThis.fetch;
      const state = "test-bank-state",
        ownerSession = "test-owner-session";
      await query(
        "INSERT INTO bank_states(state_hash,session_hash,bank,valid_until,expires_at) VALUES($1,$2,$3,now()+interval '30 days',now()+interval '20 minutes')",
        [
          digest(state),
          ownerSession,
          JSON.stringify({ name: "Test bank", country: "EE" }),
        ],
      );
      try {
        globalThis.fetch = async (input) => {
          assert.equal(new URL(String(input)).pathname, "/sessions");
          return Response.json({
            session_id: "renewed-session",
            access: {
              valid_until: new Date(Date.now() + 86400000 * 30).toISOString(),
            },
            accounts: [
              {
                uid: "renewed-eur",
                identification_hash: "wallet",
                currency: "EUR",
                account_id: { iban: "EEOWNER" },
              },
              {
                uid: "renewed-usd",
                identification_hash: "wallet",
                currency: "USD",
                account_id: { iban: "EEOWNER" },
              },
            ],
          });
        };
        await completeBankAuthorization(
          state,
          "authorization-code",
          ownerSession,
        );
        const wallets = await query(
          "SELECT id,provider_uid FROM accounts WHERE identification_hash LIKE 'wallet:%' ORDER BY currency",
        );
        assert.equal(wallets.length, 2);
        assert.equal(wallets[0].id, account.id);
        assert.equal(wallets[1].id, usd.id);
        assert.equal(wallets[0].provider_uid, "renewed-eur");
        await assert.rejects(
          completeBankAuthorization(state, "authorization-code", ownerSession),
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
  await check(
    "receipt pagination reaches older imports and filters the full collection",
    async () => {
      await query(`INSERT INTO receipts(file_hash,filename,content_type,storage_path,retailer,merchant,status,created_at)
      SELECT 'pagination-regression-'||n,'receipt-'||n||'.txt','text/plain','test-only',
        CASE WHEN n=205 THEN 'pagination-retailer' ELSE 'pagination-other' END,'Pagination receipt','ready',now()-n*interval '1 minute'
      FROM generate_series(1,205) n`);
      try {
        const params = new URLSearchParams({ retailer: "pagination-other" });
        const first = await receiptPage(params);
        assert.equal(first.count, 204);
        assert.equal(first.rows.length, 50);
        params.set("page", "5");
        const last = await receiptPage(params);
        assert.equal(last.rows.length, 4);
        assert.equal(last.page, 5);
        const oldest = await receiptPage(
          new URLSearchParams({ retailer: "pagination-retailer" }),
        );
        assert.equal(oldest.count, 1);
        assert.equal(oldest.rows[0].filename, "receipt-205.txt");
        assert.ok((await receiptList(true)).length >= 205);
        const clamped = await receiptPage(
          new URLSearchParams({ retailer: "pagination-other", page: "999" }),
        );
        assert.equal(clamped.page, 5);
      } finally {
        await query(
          "DELETE FROM receipts WHERE file_hash LIKE 'pagination-regression-%'",
        );
      }
    },
  );
  await check(
    "encrypted backup restores the database and original documents",
    async () => {
      const backup = path.join(temporary, "backup.enc");
      await writeBackup(
        database.url,
        config.dataDir,
        config.encryptionKey,
        backup,
      );
      const destination = path.join(temporary, "restored");
      await restoreBackup(
        restored.url,
        destination,
        config.encryptionKey,
        backup,
      );
      const client = new pg.Client({ connectionString: restored.url });
      await client.connect();
      try {
        assert.equal(
          (await client.query("SELECT count(*)::int AS n FROM transactions"))
            .rows[0].n,
          (await query("SELECT count(*)::int AS n FROM transactions"))[0].n,
        );
        const [original] = await query(
          "SELECT storage_path FROM receipts WHERE id=$1",
          [receiptId],
        );
        assert.deepEqual(
          await readFile(path.join(destination, original.storage_path)),
          Buffer.from(receiptText()),
        );
      } finally {
        await client.end();
      }
      const corrupted = Buffer.from(await readFile(backup));
      corrupted[30] ^= 1;
      const broken = path.join(temporary, "broken.enc");
      await writeFile(broken, corrupted);
      await assert.rejects(
        restoreBackup(restored.url, destination, config.encryptionKey, broken),
      );
    },
  );
  console.log(`${checks} integration checks passed in isolated databases.`);
} finally {
  await (await getQueue()).stop({ graceful: true });
  await pool.end();
  await database.dispose();
  await restored.dispose();
  await rm(temporary, { recursive: true, force: true });
}
