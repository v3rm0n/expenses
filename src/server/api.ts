import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./config";
import { setReceiptRequirements } from "./receipt-requirements";
import { transactionReviewQueue } from "./transaction-review";
import { importAmazonPack, MAX_AMAZON_PACK_SIZE } from "./amazon";
import {
  similarTransactions,
  type SimilarTransaction,
} from "./similar-transactions";
import { query, transaction, migrate } from "./db";
import {
  addSession,
  assertOrigin,
  createOwner,
  limitLogin,
  login,
  logout,
  requireOwner,
  sessionOwner,
  clientIp,
} from "./auth";
import { AppError, publicError } from "./errors";
import { decrypt, equalSecret, hashPassword } from "./crypto";
import {
  applicationState,
  overview,
  receiptDetail,
  receiptList,
  receiptPage,
  transactionFilters,
  transactionList,
  dateWindow,
} from "./reporting";
import {
  availableBanks,
  bankingRequest,
  startBankAuthorization,
} from "./banking";
import { enqueue } from "./queue";
import { lidlStatus, saveLidl } from "./lidl";
import {
  MAX_FILE_SIZE,
  replaceReceiptItems,
  storageFile,
  storeReceipt,
} from "./receipts";
import { MAX_EMAIL_SIZE, receiveEmail, readEmailMessage } from "./email";
import {
  applyAllocations,
  autoMatchReceipt,
  linkReceipt,
  reclassify,
  replaceAllocations,
} from "./ledger";
import {
  currencyScale,
  decimalMoney,
  parseMoney,
  validDate,
} from "../lib/money";
import {
  matchingRule,
  contributionCategory,
  allocationAmount,
  normalize,
  productCategory,
} from "../lib/classification";
import type { Allocation, Retailer, Rule } from "../lib/types";

const identifier = z.string().regex(/^[\w-]{1,100}$/);
const uuid = (value: string) => z.uuid().parse(value);
const json = (value: unknown, status = 200) =>
  NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
const moneyInput = z.union([z.string().max(40), z.number()]);
const currencyInput = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .refine((value) => {
    try {
      currencyScale(value);
      return true;
    } catch {
      return false;
    }
  }, "Enter a currency code such as EUR.");
const dateInput = z.string().refine((value) => {
  try {
    validDate(value);
    return true;
  } catch {
    return false;
  }
}, "Enter a valid date.");
const receiptItemInput = z.object({
  description: z.string().trim().min(1).max(300),
  amount: moneyInput,
  category_id: identifier,
  quantity: z.string().max(40).nullable().optional(),
  unit: z.string().max(30).nullable().optional(),
});

export async function handleApi(
  request: NextRequest,
  segments: string[],
): Promise<NextResponse> {
  const route = segments.join("/"),
    method = request.method,
    params = request.nextUrl.searchParams;
  try {
    await migrate();
    if (route === "health" && method === "GET") {
      await query("SELECT 1");
      return json({ ok: true });
    }
    if (route === "inbound/email" && method === "POST") {
      const token =
        request.headers.get("authorization")?.replace(/^Bearer /, "") || "";
      if (
        !config.inboundToken ||
        !token ||
        !equalSecret(token, config.inboundToken)
      )
        throw new AppError("Invalid email receiver token.", 401);
      if (Number(request.headers.get("content-length")) > MAX_EMAIL_SIZE)
        throw new AppError("Email exceeds the 20 MB limit.", 413);
      return json(
        await receiveEmail(await boundedBody(request, MAX_EMAIL_SIZE)),
        202,
      );
    }
    if (route === "auth/status" && method === "GET") {
      const exists = (await query("SELECT 1 FROM owner")).length > 0;
      const owner = await sessionOwner();
      return json({
        needsSetup: !exists,
        authenticated: Boolean(owner),
        name: owner?.name || null,
      });
    }
    if (method !== "GET") assertOrigin(request);
    if (route === "auth/setup" && method === "POST") {
      await limitLogin(request);
      const input = z
        .object({ name: z.string(), password: z.string(), token: z.string() })
        .parse(await request.json());
      await createOwner(input.name, input.password, input.token);
      const response = json({ ok: true });
      await addSession(response, request);
      return response;
    }
    if (route === "auth/login" && method === "POST") {
      await limitLogin(request);
      const input = z
        .object({ password: z.string() })
        .parse(await request.json());
      await login(input.password);
      const response = json({ ok: true });
      await addSession(response, request);
      return response;
    }
    const owner = await requireOwner();
    if (route === "auth/logout" && method === "POST") {
      const response = json({ ok: true });
      await logout(response);
      return response;
    }
    if (route === "state" && method === "GET")
      return json(await applicationState());
    if (
      segments[0] === "accounts" &&
      segments.length === 2 &&
      method === "POST"
    ) {
      const id = uuid(segments[1]);
      const input = z
        .object({ nickname: z.string().trim().max(100).nullable() })
        .parse(await request.json());
      const [account] = await query(
        "UPDATE accounts SET nickname=$2 WHERE id=$1 RETURNING id,name,nickname",
        [id, input.nickname || null],
      );
      if (!account) throw new AppError("Account not found.", 404);
      return json(account);
    }
    if (route === "overview" && method === "GET") {
      const month =
          params.get("month") ||
          new Intl.DateTimeFormat("sv-SE", {
            timeZone: "Europe/Tallinn",
            year: "numeric",
            month: "2-digit",
          }).format(new Date()),
        currency = currencyInput.parse(params.get("currency") || "EUR");
      return json(await overview(month, currency));
    }
    if (route === "transactions" && method === "GET")
      return json(await transactionList(params));
    if (route === "transactions" && method === "POST") {
      const input = z
        .object({
          merchant: z.string().trim().min(1).max(200),
          description: z.string().max(1000).default(""),
          date: dateInput,
          amount: moneyInput,
          currency: currencyInput,
          category: identifier,
          kind: z.enum(["expense", "income", "refund"]).default("expense"),
          idempotencyKey: z.uuid(),
        })
        .parse(await request.json());
      if (["investments", "pension"].includes(input.category))
        throw new AppError(
          "Record the payment, then choose its Investment transfer or Pension contribution type.",
        );
      const magnitude = Math.abs(parseMoney(input.amount, input.currency));
      if (!magnitude) throw new AppError("Enter a nonzero amount.");
      const result = await transaction(async (db) => {
        const [account] = await query(
          "INSERT INTO accounts(identification_hash,name,currency,source) VALUES($1,$2,$3,'cash') ON CONFLICT(identification_hash) DO UPDATE SET name=excluded.name RETURNING id",
          [
            `cash:${input.currency}`,
            `Cash · ${input.currency}`,
            input.currency,
          ],
          db,
        );
        const [entry] = await query(
          `INSERT INTO transactions(account_id,source_key,amount,currency,kind,booked_at,merchant,description,manual)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,true) ON CONFLICT(account_id,source_key) DO UPDATE SET source_key=excluded.source_key RETURNING id`,
          [
            account.id,
            `manual:${input.idempotencyKey}`,
            input.kind === "expense" ? -magnitude : magnitude,
            input.currency,
            input.kind,
            input.date,
            input.merchant,
            input.description,
          ],
          db,
        );
        await replaceAllocations(
          entry.id,
          input.kind === "income"
            ? []
            : [
                {
                  categoryId: input.category,
                  amount: input.kind === "expense" ? magnitude : -magnitude,
                  source: "manual",
                },
              ],
          input.kind === "income"
            ? 0
            : input.kind === "expense"
              ? magnitude
              : -magnitude,
          db,
        );
        return entry;
      });
      return json(result, 201);
    }
    if (route === "transactions/receipt-requirement" && method === "POST") {
      const input = z
        .object({
          ids: z.array(z.uuid()).min(1).max(500),
          receiptNotRequired: z.boolean(),
        })
        .strict()
        .parse(await request.json());
      const count = await transaction(async (db) => {
        await db.query("SELECT pg_advisory_xact_lock(4317004)");
        const entries = await query(
          "SELECT kind FROM transactions WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
          [input.ids],
          db,
        );
        if (
          entries.some((entry) => !["expense", "refund"].includes(entry.kind))
        )
          throw new AppError(
            "Select expenses or refunds to update receipt requirements.",
          );
        return setReceiptRequirements(input.ids, input.receiptNotRequired, db, {
          bulk: true,
        });
      });
      return json({ ok: true, count });
    }
    if (
      segments[0] === "transactions" &&
      segments.length === 3 &&
      segments[2] === "receipt-requirement" &&
      method === "POST"
    ) {
      const id = uuid(segments[1]);
      const input = z
        .object({
          receiptNotRequired: z.boolean(),
          similarPattern: z.string().trim().max(200).optional(),
        })
        .strict()
        .parse(await request.json());
      const count = await transaction(async (db) => {
        await db.query("SELECT pg_advisory_xact_lock(4317004)");
        const [entry] = await query<SimilarTransaction>(
          "SELECT * FROM transactions WHERE id=$1 FOR UPDATE",
          [id],
          db,
        );
        if (!entry) throw new AppError("Transaction not found.", 404);
        const matches =
          input.similarPattern === undefined
            ? []
            : await similarTransactions(
                entry,
                input.similarPattern,
                db,
                true,
                true,
              );
        return setReceiptRequirements(
          [id, ...matches.map((row) => row.id)],
          input.receiptNotRequired,
          db,
          input.similarPattern === undefined
            ? {}
            : { similarPattern: input.similarPattern, sourceTransactionId: id },
        );
      });
      return json({ ok: true, count });
    }
    if (
      segments[0] === "transactions" &&
      segments.length === 3 &&
      segments[2] === "similar" &&
      method === "GET"
    ) {
      const [entry] = await query<SimilarTransaction>(
        "SELECT * FROM transactions WHERE id=$1",
        [uuid(segments[1])],
      );
      if (!entry) throw new AppError("Transaction not found.", 404);
      const pattern = z
        .string()
        .trim()
        .max(200)
        .parse(params.get("pattern") || "");
      const receiptPurpose = params.get("purpose") === "receipt";
      let matches = await similarTransactions(
        entry,
        pattern,
        undefined,
        false,
        receiptPurpose || params.get("includeManual") === "true",
      );
      if (receiptPurpose)
        matches = matches.filter(
          (row) =>
            row.receipt_not_required !==
            (params.get("receiptNotRequired") === "true"),
        );
      return json({
        count: matches.length,
        examples: matches
          .slice(0, 5)
          .map(
            ({ id, merchant, description, booked_at, amount, currency }) => ({
              id,
              merchant,
              description,
              booked_at,
              amount,
              currency,
            }),
          ),
      });
    }
    if (segments[0] === "transactions" && segments.length === 2) {
      const id = uuid(segments[1]);
      if (method === "DELETE") {
        await transaction(async (db) => {
          const [entry] = await query(
            "SELECT t.id,a.source FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE t.id=$1 FOR UPDATE OF t",
            [id],
            db,
          );
          if (!entry) throw new AppError("Transaction not found.", 404);
          if (entry.source !== "cash")
            throw new AppError(
              "Bank transactions cannot be deleted. Correct their classification instead.",
            );
          const links = await query(
            "SELECT receipt_id FROM receipt_payments WHERE transaction_id=$1",
            [id],
            db,
          );
          await db.query("DELETE FROM transactions WHERE id=$1", [id]);
          for (const link of links)
            await db.query(
              "UPDATE receipts SET status=CASE WHEN EXISTS(SELECT 1 FROM receipt_payments WHERE receipt_id=$1) THEN 'matched' ELSE 'ready' END WHERE id=$1",
              [link.receipt_id],
            );
          await db.query(
            "INSERT INTO corrections(entity,entity_id,change) VALUES('transaction',$1,'{\"deleted\":true}')",
            [id],
          );
        });
        return json({ ok: true });
      }
      if (method === "GET") {
        const [entry] = await query(
          "SELECT t.*,COALESCE(NULLIF(a.nickname,''),a.name) AS account_name,a.source FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE t.id=$1",
          [id],
        );
        if (!entry) throw new AppError("Transaction not found.", 404);
        const allocations = await query(
          "SELECT a.*,c.name,c.color FROM allocations a JOIN categories c ON c.id=a.category_id WHERE transaction_id=$1",
          [id],
        );
        const receipts = await query(
          "SELECT r.id,r.filename,r.merchant,r.total,r.currency,r.status,p.amount AS linked_amount FROM receipts r JOIN receipt_payments p ON p.receipt_id=r.id WHERE p.transaction_id=$1",
          [id],
        );
        return json({ ...entry, allocations, receipts });
      }
      if (method === "POST") {
        const input = z
          .object({
            kind: z.enum([
              "expense",
              "income",
              "refund",
              "transfer",
              "cash_movement",
              "investment",
              "pension",
            ]),
            note: z.string().max(2000).default(""),
            automatic: z.boolean().default(false),
            similarPattern: z.string().trim().max(200).optional(),
            similarIncludeManual: z.boolean().default(false),
            allocations: z
              .array(z.object({ category_id: identifier, amount: moneyInput }))
              .max(100)
              .default([]),
          })
          .parse(await request.json());
        const count = await transaction(async (db) => {
          if (input.similarPattern !== undefined)
            await db.query("SELECT pg_advisory_xact_lock(4317004)");
          const [entry] = await query<SimilarTransaction>(
            "SELECT * FROM transactions WHERE id=$1 FOR UPDATE",
            [id],
            db,
          );
          if (!entry) throw new AppError("Transaction not found.", 404);
          if (
            (input.kind === "expense" && entry.amount >= 0) ||
            (["income", "refund"].includes(input.kind) && entry.amount <= 0)
          )
            throw new AppError(
              "The selected type does not match the payment direction.",
            );
          if (
            input.kind !== entry.kind &&
            (
              await query(
                "SELECT 1 FROM receipt_payments WHERE transaction_id=$1",
                [id],
                db,
              )
            ).length
          )
            throw new AppError(
              "Unlink receipts before changing the payment type.",
            );
          let matches: Awaited<ReturnType<typeof similarTransactions>> = [];
          if (input.similarPattern !== undefined) {
            if (
              input.automatic ||
              !["expense", "refund"].includes(input.kind) ||
              input.kind !== entry.kind ||
              input.allocations.length !== 1
            )
              throw new AppError(
                "Choose one category and keep the payment type to categorize similar transactions.",
              );
            const amount = parseMoney(
              input.allocations[0].amount,
              entry.currency,
            );
            if (amount !== allocationAmount(input.kind, entry.amount))
              throw new AppError(
                "Category allocations must equal the expense amount.",
              );
            matches = await similarTransactions(
              entry,
              input.similarPattern,
              db,
              true,
              input.similarIncludeManual,
            );
          }
          await db.query(
            "UPDATE transactions SET kind=$2,note=$3,manual=$4,updated_at=now() WHERE id=$1",
            [id, input.kind, input.note, !input.automatic],
          );
          if (input.automatic) await applyAllocations(id, db, true);
          else {
            const expected = allocationAmount(input.kind, entry.amount);
            const capitalCategory = contributionCategory(input.kind);
            if (
              !capitalCategory &&
              input.allocations.some((a) =>
                ["investments", "pension"].includes(a.category_id),
              )
            )
              throw new AppError(
                "Choose the Investment transfer or Pension contribution payment type.",
              );
            const allocations: Allocation[] = capitalCategory
              ? [
                  {
                    categoryId: capitalCategory,
                    amount: expected,
                    source: "manual",
                  },
                ]
              : expected
                ? input.allocations.map((a) => ({
                    categoryId: a.category_id,
                    amount: parseMoney(a.amount, entry.currency),
                    source: "manual",
                  }))
                : [];
            await replaceAllocations(id, allocations, expected, db);
          }
          await db.query(
            "INSERT INTO corrections(entity,entity_id,change) VALUES('transaction',$1,$2)",
            [id, JSON.stringify(input)],
          );
          for (const match of matches) {
            const expected = allocationAmount(match.kind, match.amount);
            await replaceAllocations(
              match.id,
              [
                {
                  categoryId: input.allocations[0].category_id,
                  amount: expected,
                  source: "manual",
                },
              ],
              expected,
              db,
            );
            await db.query(
              "UPDATE transactions SET manual=true,updated_at=now() WHERE id=$1",
              [match.id],
            );
            await db.query(
              "INSERT INTO corrections(entity,entity_id,change) VALUES('transaction',$1,$2)",
              [
                match.id,
                JSON.stringify({
                  category_id: input.allocations[0].category_id,
                  similarTo: id,
                  pattern: input.similarPattern,
                }),
              ],
            );
          }
          return matches.length + 1;
        });
        return json({ ok: true, count });
      }
    }
    if (route === "receipts" && method === "GET")
      return json(await receiptPage(params));
    if (route === "receipts/upload" && method === "POST") {
      if (Number(request.headers.get("content-length")) > 100 * 1024 * 1024)
        throw new AppError("Upload at most 100 MB per batch.", 413);
      const form = await request.formData(),
        files = form
          .getAll("files")
          .filter((file): file is File => file instanceof File);
      if (!files.length || files.length > 20)
        throw new AppError("Choose between 1 and 20 files.");
      const hint = z
        .enum([
          "unknown",
          "rimi",
          "partnerkaart",
          "coop",
          "maxima",
          "lidl",
          "wolt",
          "amazon",
        ])
        .parse(form.get("retailer") || "unknown");
      const results = [];
      for (const file of files) {
        try {
          if (
            file.size >
            (/\.amazon\.json$/i.test(file.name)
              ? MAX_AMAZON_PACK_SIZE
              : /\.eml$/i.test(file.name)
                ? MAX_EMAIL_SIZE
                : MAX_FILE_SIZE)
          )
            throw new AppError("This file exceeds the size limit.");
          const buffer = Buffer.from(await file.arrayBuffer());
          if (/\.amazon\.json$/i.test(file.name)) {
            const pack = await importAmazonPack(buffer);
            results.push(...pack.results);
            if (pack.missing)
              results.push({
                filename: file.name,
                error: `${pack.missing} Amazon orders have no downloadable invoice. Their payments remain available for review.`,
              });
            continue;
          }
          const result = /\.eml$/i.test(file.name)
            ? { ...(await receiveEmail(buffer)), email: true }
            : await storeReceipt(buffer, file.name, hint as Retailer);
          results.push({ filename: file.name, ...result });
        } catch (error) {
          results.push({ filename: file.name, error: publicError(error) });
        }
      }
      return json({ results }, 202);
    }
    if (segments[0] === "receipts" && segments.length >= 2) {
      const id = uuid(segments[1]),
        action = segments[2];
      if (!action && method === "GET")
        return json(
          await receiptDetail(
            id,
            params.get("transaction") ? uuid(params.get("transaction")!) : null,
          ),
        );
      if (action === "file" && method === "GET") {
        const [receipt] = await query("SELECT * FROM receipts WHERE id=$1", [
          id,
        ]);
        if (!receipt) throw new AppError("Receipt not found.", 404);
        return documentResponse(
          await readFile(storageFile(receipt.storage_path)),
          receipt.filename,
          receipt.content_type,
          params.get("download") === "true",
        );
      }
      if (action === "retry" && method === "POST") {
        const [receipt] = await query(
          "SELECT manual FROM receipts WHERE id=$1",
          [id],
        );
        if (!receipt) throw new AppError("Receipt not found.", 404);
        if (receipt.manual)
          throw new AppError(
            "This receipt has manual corrections. Edit its details to preserve those corrections.",
          );
        await query(
          "UPDATE receipts SET status='processing',error=NULL WHERE id=$1",
          [id],
        );
        await enqueue("receipt-parse", { receiptId: id }, id);
        return json({ ok: true }, 202);
      }
      if (!action && method === "POST") {
        const input = z
          .object({
            merchant: z.string().trim().min(1).max(200),
            retailer: z.enum([
              "unknown",
              "rimi",
              "partnerkaart",
              "coop",
              "maxima",
              "lidl",
              "wolt",
              "amazon",
            ]),
            purchased_at: dateInput,
            receipt_number: z.string().max(100).nullable().optional(),
            currency: currencyInput,
            total: moneyInput,
            items: z.array(receiptItemInput).min(1).max(500),
            remember: z.boolean().default(false),
          })
          .parse(await request.json());
        const total = parseMoney(input.total, input.currency),
          items = input.items.map((item) => ({
            ...item,
            amount: parseMoney(item.amount, input.currency),
            manual: true,
          }));
        if (
          !total ||
          items.reduce((sum, item) => sum + item.amount, 0) !== total
        )
          throw new AppError(
            "Product amounts must add up exactly to the nonzero receipt total.",
          );
        await transaction(async (db) => {
          const [receipt] = await query(
            "SELECT * FROM receipts WHERE id=$1 FOR UPDATE",
            [id],
            db,
          );
          if (!receipt) throw new AppError("Receipt not found.", 404);
          const links = await query(
            "SELECT * FROM receipt_payments WHERE receipt_id=$1",
            [id],
            db,
          );
          if (
            links.length &&
            (receipt.currency !== input.currency ||
              Math.sign(receipt.total) !== Math.sign(total) ||
              links.reduce((sum, link) => sum + link.amount, 0) >
                Math.abs(total))
          )
            throw new AppError(
              "Unlink payments before changing currency, direction, or reducing the receipt below its linked amount.",
            );
          await db.query(
            "UPDATE receipts SET merchant=$2,retailer=$3,purchased_at=$4,receipt_number=$5,currency=$6,total=$7,status=$8,issues='[]',error=NULL,manual=true,updated_at=now() WHERE id=$1",
            [
              id,
              input.merchant,
              input.retailer,
              input.purchased_at,
              input.receipt_number || null,
              input.currency,
              total,
              links.length ? "matched" : "ready",
            ],
          );
          await replaceReceiptItems(id, items, db);
          if (input.remember)
            for (const item of items)
              await db.query(
                "INSERT INTO product_mappings(retailer,product,category_id) VALUES($1,$2,$3) ON CONFLICT(retailer,product) DO UPDATE SET category_id=excluded.category_id",
                [input.retailer, normalize(item.description), item.category_id],
              );
          for (const link of links)
            await applyAllocations(link.transaction_id, db);
          if (!links.length) await autoMatchReceipt(id, db);
          await db.query(
            "INSERT INTO corrections(entity,entity_id,change) VALUES('receipt',$1,$2)",
            [id, JSON.stringify(input)],
          );
        });
        return json({ ok: true });
      }
      if (action === "link" && method === "POST") {
        const input = z
          .object({ transactionId: z.uuid(), amount: moneyInput })
          .parse(await request.json());
        await transaction(async (db) => {
          const [receipt] = await query(
            "SELECT currency FROM receipts WHERE id=$1",
            [id],
            db,
          );
          if (!receipt) throw new AppError("Receipt not found.", 404);
          await linkReceipt(
            id,
            input.transactionId,
            parseMoney(input.amount, receipt.currency),
            false,
            db,
          );
        });
        return json({ ok: true });
      }
      if (action === "unlink" && method === "POST") {
        const input = z
          .object({ transactionId: z.uuid() })
          .parse(await request.json());
        await transaction(async (db) => {
          await db.query("SELECT id FROM receipts WHERE id=$1 FOR UPDATE", [
            id,
          ]);
          await db.query(
            "DELETE FROM receipt_payments WHERE receipt_id=$1 AND transaction_id=$2",
            [id, input.transactionId],
          );
          await db.query(
            "UPDATE receipts SET status=CASE WHEN EXISTS(SELECT 1 FROM receipt_payments WHERE receipt_id=$1) THEN 'matched' ELSE 'ready' END WHERE id=$1",
            [id],
          );
          await applyAllocations(input.transactionId, db);
        });
        return json({ ok: true });
      }
      if (action === "cash" && method === "POST") {
        await transaction(async (db) => {
          const [receipt] = await query(
            "SELECT * FROM receipts WHERE id=$1 FOR UPDATE",
            [id],
            db,
          );
          if (
            !receipt ||
            !["ready", "matched"].includes(receipt.status) ||
            !receipt.total
          )
            throw new AppError(
              "Validate the receipt before recording cash payment.",
            );
          const [paid] = await query(
            "SELECT coalesce(sum(amount),0)::bigint AS amount FROM receipt_payments WHERE receipt_id=$1",
            [id],
            db,
          );
          const remaining = Math.abs(receipt.total) - paid.amount;
          if (remaining <= 0)
            throw new AppError("This receipt is already fully linked.");
          const [account] = await query(
            "INSERT INTO accounts(identification_hash,name,currency,source) VALUES($1,$2,$3,'cash') ON CONFLICT(identification_hash) DO UPDATE SET name=excluded.name RETURNING id",
            [
              `cash:${receipt.currency}`,
              `Cash · ${receipt.currency}`,
              receipt.currency,
            ],
            db,
          );
          const [entry] = await query(
            "INSERT INTO transactions(account_id,source_key,amount,currency,kind,booked_at,merchant) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(account_id,source_key) DO UPDATE SET amount=excluded.amount RETURNING id",
            [
              account.id,
              `receipt:${id}`,
              -Math.sign(receipt.total) * remaining,
              receipt.currency,
              receipt.total > 0 ? "expense" : "refund",
              receipt.purchased_at,
              receipt.merchant,
            ],
            db,
          );
          await linkReceipt(id, entry.id, remaining, false, db);
        });
        return json({ ok: true });
      }
    }
    if (route === "review/transactions" && method === "GET")
      return json(await transactionReviewQueue(params));
    if (route === "review" && method === "GET")
      return json({
        transactions: (
          await transactionList(
            new URLSearchParams({ review: "true", limit: "100" }),
          )
        ).rows,
        receipts: await receiptList(true),
        emails: await query(
          "SELECT id,sender,subject,status,error,received_at FROM inbound_emails WHERE status IN ('review','error') ORDER BY received_at DESC LIMIT 50",
        ),
      });
    if (route === "banks" && method === "GET")
      return json(
        await availableBanks((params.get("country") || "EE").toUpperCase()),
      );
    if (route === "connections" && method === "GET")
      return json(
        await query(
          "SELECT id,bank_name,country,status,valid_until,last_sync_at,last_error,created_at FROM bank_connections ORDER BY bank_name",
        ),
      );
    if (route === "connections/start" && method === "POST") {
      if (
        request.headers.get("origin") !== new URL(config.bankingRedirect).origin
      )
        throw new AppError(
          `Open the application at ${config.appUrl} before connecting a bank so the bank can return to your signed-in browser.`,
        );
      const input = z
        .object({
          bank: z.string().max(200),
          country: z.string().regex(/^[A-Z]{2}$/),
        })
        .parse(await request.json());
      return json(
        await startBankAuthorization(
          input.bank,
          input.country,
          owner.token_hash,
        ),
      );
    }
    if (
      segments[0] === "connections" &&
      segments[2] === "sync" &&
      method === "POST"
    ) {
      const id = uuid(segments[1]);
      const [connection] = await query(
        "SELECT bank_metadata,status FROM bank_connections WHERE id=$1",
        [id],
      );
      if (!connection || connection.status === "disconnected")
        throw new AppError("Connect this bank first.");
      const headers: Record<string, string> = {
        "psu-user-agent":
          request.headers.get("user-agent") ||
          "Expenses personal web application",
      };
      const ip = clientIp(request);
      if (ip !== "local") headers["psu-ip-address"] = ip;
      for (const [incoming, outgoing] of [
        ["accept", "psu-accept"],
        ["accept-language", "psu-accept-language"],
        ["accept-encoding", "psu-accept-encoding"],
        ["referer", "psu-referer"],
      ]) {
        const value = request.headers.get(incoming);
        if (value) headers[outgoing] = value;
      }
      const needed: string[] =
        connection.bank_metadata.required_psu_headers || [];
      if (needed.some((name) => !headers[name.toLowerCase()]))
        throw new AppError(
          "Your proxy must provide the client IP for this bank. Scheduled background imports remain available.",
        );
      await enqueue("bank-sync", { connectionId: id, psuHeaders: headers }, id);
      return json({ ok: true }, 202);
    }
    if (
      segments[0] === "connections" &&
      segments.length === 2 &&
      method === "DELETE"
    ) {
      const id = uuid(segments[1]);
      const [connection] = await query(
        "SELECT session_cipher,status FROM bank_connections WHERE id=$1",
        [id],
      );
      if (!connection) throw new AppError("Bank connection not found.", 404);
      if (connection.status !== "disconnected") {
        try {
          await bankingRequest(
            `/sessions/${encodeURIComponent(decrypt<{ id: string }>(connection.session_cipher).id)}`,
            undefined,
            {},
            "DELETE",
          );
        } catch (error) {
          if (!(error instanceof AppError && error.status === 410)) throw error;
        }
      }
      await query(
        "UPDATE bank_connections SET status='disconnected' WHERE id=$1",
        [id],
      );
      return json({ ok: true });
    }
    if (route === "rules" && method === "GET")
      return json(
        await query(
          "SELECT r.*,c.name AS category_name FROM rules r JOIN categories c ON c.id=r.category_id ORDER BY priority,created_at",
        ),
      );
    if (route === "rules" && method === "POST") {
      const input = z
        .object({
          field: z.enum(["merchant", "description", "product"]),
          pattern: z.string().trim().min(1).max(200),
          category_id: identifier,
          priority: z.number().int().min(0).max(10000).default(100),
          applyExisting: z.boolean().default(false),
        })
        .parse(await request.json());
      if (
        input.field === "product" &&
        ["investments", "pension"].includes(input.category_id)
      )
        throw new AppError(
          "Investment and pension rules must match a payment merchant or description.",
        );
      const [rule] = await query(
        "INSERT INTO rules(field,pattern,category_id,priority) VALUES($1,$2,$3,$4) RETURNING id",
        [input.field, input.pattern, input.category_id, input.priority],
      );
      if (input.applyExisting) await applyRulesToHistory();
      return json(rule, 201);
    }
    if (route === "rules/preview" && method === "POST") {
      const input = z
        .object({
          field: z.enum(["merchant", "description", "product"]),
          pattern: z.string().trim().min(1).max(200),
        })
        .parse(await request.json());
      const rows =
        input.field === "product"
          ? await query(
              "SELECT description AS value FROM receipt_items WHERE NOT manual",
            )
          : await query(
              `SELECT ${input.field === "merchant" ? "merchant" : "description"} AS value FROM transactions WHERE NOT manual`,
            );
      const matches = rows.filter((row) =>
        normalize(row.value).includes(normalize(input.pattern)),
      );
      return json({
        count: matches.length,
        examples: matches.slice(0, 5).map((row) => row.value),
      });
    }
    if (route === "rules/apply" && method === "POST")
      return json({ count: await applyRulesToHistory() });
    if (segments[0] === "rules" && segments.length === 2 && method === "POST") {
      const input = z
        .object({
          enabled: z.boolean(),
          priority: z.number().int().min(0).max(10000),
        })
        .parse(await request.json());
      await query("UPDATE rules SET enabled=$2,priority=$3 WHERE id=$1", [
        uuid(segments[1]),
        input.enabled,
        input.priority,
      ]);
      await applyRulesToHistory();
      return json({ ok: true });
    }
    if (
      segments[0] === "rules" &&
      segments.length === 2 &&
      method === "DELETE"
    ) {
      await query("DELETE FROM rules WHERE id=$1", [uuid(segments[1])]);
      await applyRulesToHistory();
      return json({ ok: true });
    }
    if (route === "categories" && method === "POST") {
      const input = z
        .object({
          id: identifier.optional(),
          name: z.string().trim().min(1).max(80),
          color: z.string().regex(/^#[a-f\d]{6}$/i),
        })
        .parse(await request.json());
      const id = input.id || `custom-${randomUUID()}`;
      await query(
        "INSERT INTO categories(id,name,color) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color",
        [id, input.name, input.color],
      );
      return json({ id });
    }
    if (route === "settings" && method === "GET") {
      const [heartbeat] = await query(
        "SELECT value,updated_at FROM settings WHERE key='worker_heartbeat'",
      );
      return json({
        appUrl: config.appUrl,
        bankingRedirect: config.bankingRedirect,
        port: config.port,
        host: config.host,
        bankingConfigured: Boolean(config.bankingId && config.bankingKeyPath),
        workerAt: heartbeat?.updated_at || null,
        inboundUrl: `${config.appUrl}/api/inbound/email`,
        lidl: await lidlStatus(),
      });
    }
    if (route === "settings/lidl" && method === "POST") {
      const input = z
        .object({
          user: z
            .email()
            .max(254)
            .transform((value) => value.toLowerCase()),
          password: z.string().max(1000).optional(),
          enabled: z.boolean(),
        })
        .parse(await request.json());
      await saveLidl(input);
      if (input.enabled) await enqueue("lidl-sync", {}, "lidl");
      return json({ ok: true }, 202);
    }
    if (route === "settings/lidl/sync" && method === "POST") {
      const status = await lidlStatus();
      if (!status?.enabled)
        throw new AppError("Enable the Lidl connection first.");
      await enqueue("lidl-sync", {}, "lidl");
      return json({ ok: true }, 202);
    }
    if (route === "settings/lidl" && method === "DELETE") {
      await query("DELETE FROM settings WHERE key='lidl'");
      return json({ ok: true });
    }
    if (route === "settings/inbound-token" && method === "POST")
      return json({ token: config.inboundToken });
    if (route === "settings/banking-check" && method === "POST") {
      const metadata = await bankingRequest<{
        active: boolean;
        environment: string;
        services: string[];
      }>("/application");
      return json({
        active: metadata.active,
        environment: metadata.environment,
        services: metadata.services,
      });
    }
    if (route === "settings/password" && method === "POST") {
      const input = z
        .object({
          currentPassword: z.string(),
          password: z.string().min(12).max(256),
        })
        .parse(await request.json());
      await login(input.currentPassword);
      await transaction(async (db) => {
        await db.query("UPDATE owner SET password_hash=$1 WHERE id=1", [
          await hashPassword(input.password),
        ]);
        await db.query("DELETE FROM web_sessions WHERE token_hash<>$1", [
          owner.token_hash,
        ]);
      });
      return json({ ok: true });
    }
    if (route === "emails" && method === "GET")
      return json(
        await query(
          "SELECT id,sender,subject,status,error,receipt_ids,received_at FROM inbound_emails ORDER BY received_at DESC LIMIT 100",
        ),
      );
    if (segments[0] === "emails" && segments.length === 2 && method === "GET")
      return json(await readEmailMessage(uuid(segments[1])));
    if (
      segments[0] === "emails" &&
      segments[2] === "file" &&
      method === "GET"
    ) {
      const [email] = await query("SELECT * FROM inbound_emails WHERE id=$1", [
        uuid(segments[1]),
      ]);
      if (!email) throw new AppError("Email not found.", 404);
      return documentResponse(
        await readFile(storageFile(email.storage_path)),
        "receipt-email.eml",
        "message/rfc822",
        true,
      );
    }
    if (
      segments[0] === "emails" &&
      segments[2] === "retry" &&
      method === "POST"
    ) {
      const id = uuid(segments[1]);
      await query(
        "UPDATE inbound_emails SET status='received',error=NULL WHERE id=$1",
        [id],
      );
      await enqueue("email-parse", { emailId: id }, id);
      return json({ ok: true }, 202);
    }
    if (route === "imports" && method === "GET")
      return json(
        await query(
          "SELECT * FROM import_runs ORDER BY started_at DESC LIMIT 50",
        ),
      );
    if (route === "export" && method === "GET") return await exportCsv(params);
    throw new AppError("This endpoint was not found.", 404);
  } catch (error) {
    if (error instanceof z.ZodError)
      return json(
        { error: error.issues[0]?.message || "Check the submitted values." },
        400,
      );
    if (
      error instanceof Error &&
      /^(?:Enter an amount|Amounts in [A-Z]{3} support|Amount is too large|Invalid date|Invalid currency code)/.test(
        error.message,
      )
    )
      return json({ error: error.message }, 400);
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23503"
    )
      return json(
        {
          error:
            "The selected category or record no longer exists. Refresh and try again.",
        },
        400,
      );
    if (!(error instanceof AppError))
      console.error(
        "Application request failed:",
        error instanceof Error ? error.name : "Unknown error",
      );
    return json(
      { error: publicError(error) },
      error instanceof AppError ? error.status : 500,
    );
  }
}
async function applyRulesToHistory() {
  return transaction(async (db) => {
    const rules = await query<Rule>(
      "SELECT * FROM rules WHERE enabled ORDER BY priority",
      [],
      db,
    );
    const items = await query(
      "SELECT i.*,r.merchant FROM receipt_items i JOIN receipts r ON r.id=i.receipt_id WHERE NOT i.manual",
      [],
      db,
    );
    for (const item of items) {
      const rule = matchingRule(
        rules.filter((rule) => rule.field === "product"),
        item.merchant || "",
        "",
        item.description,
      );
      await db.query("UPDATE receipt_items SET category_id=$2 WHERE id=$1", [
        item.id,
        rule?.category_id || productCategory(item.description),
      ]);
    }
    return reclassify(db);
  });
}
function documentResponse(
  buffer: Buffer,
  filename: string,
  contentType: string,
  download: boolean,
) {
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
export async function boundedBody(
  request: NextRequest,
  limit: number,
): Promise<Buffer> {
  if (!request.body) throw new AppError("The email body is empty.");
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new AppError("The request exceeds the size limit.", 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
async function exportCsv(params: URLSearchParams) {
  const type = params.get("type") || "expenses";
  if (!["expenses", "allocations", "items"].includes(type))
    throw new AppError("Choose an export type.");
  const values: unknown[] = [],
    conditions: string[] = [];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    conditions.push(sql.replace("?", `$${values.length}`));
  };
  const alias = type === "items" ? "r" : "t",
    date = type === "items" ? "purchased_at" : "booked_at";
  if (type === "items" && params.get("currency"))
    add(`${alias}.currency=?`, currencyInput.parse(params.get("currency")));
  if (type === "items" && params.get("month")) {
    const window = dateWindow(params.get("month")!);
    add(`${alias}.${date}>=?`, window.from);
    add(`${alias}.${date}<?`, window.to);
  }
  const filters = transactionFilters(params);
  let rows;
  if (type === "items")
    rows = await query(
      `SELECT r.purchased_at AS date,r.merchant,r.currency,i.description,i.quantity,i.unit,i.amount,c.name AS category FROM receipt_items i JOIN receipts r ON r.id=i.receipt_id JOIN categories c ON c.id=i.category_id WHERE r.status<>'duplicate' ${conditions.length ? `AND ${conditions.join(" AND ")}` : ""} ORDER BY date,i.position`,
      values,
    );
  else if (type === "allocations")
    rows = await query(
      `SELECT t.booked_at AS date,t.merchant,t.currency,t.kind,a.amount,c.name AS category,a.source FROM allocations a JOIN transactions t ON t.id=a.transaction_id JOIN categories c ON c.id=a.category_id WHERE t.status='BOOK' AND ${filters.where} ORDER BY date,t.created_at,t.id`,
      filters.values,
    );
  else
    rows = await query(
      `SELECT t.booked_at AS date,t.merchant,t.description,t.currency,t.amount,t.kind,t.status,t.note FROM transactions t WHERE ${filters.where} ORDER BY date,t.created_at,t.id`,
      filters.values,
    );
  const columns =
    type === "items"
      ? [
          "date",
          "merchant",
          "currency",
          "description",
          "quantity",
          "unit",
          "amount",
          "category",
        ]
      : type === "allocations"
        ? [
            "date",
            "merchant",
            "currency",
            "kind",
            "amount",
            "category",
            "source",
          ]
        : [
            "date",
            "merchant",
            "description",
            "currency",
            "amount",
            "kind",
            "status",
            "note",
          ];
  const escape = (value: unknown, numeric = false) => {
    let text = String(value ?? "");
    if (!numeric && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const csv = [
    columns.join(","),
    ...rows.map((row) =>
      columns
        .map((column) =>
          escape(
            column === "amount"
              ? decimalMoney(row.amount, row.currency)
              : row[column],
            column === "amount",
          ),
        )
        .join(","),
    ),
  ].join("\r\n");
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="expenses-${type}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
