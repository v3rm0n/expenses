import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { config } from "./config";
import { pool, query, transaction, type DB } from "./db";
import { decrypt, digest, encrypt, secretToken } from "./crypto";
import { AppError, publicError } from "./errors";
import type { Bank, BankTransaction } from "../lib/types";
import { parseMoney, validDate } from "../lib/money";
import { transactionKind, normalize } from "../lib/classification";
import { applyAllocations, autoMatchReceipt, linkReceipt } from "./ledger";
import { enqueue } from "./queue";

export async function bankingRequest<T = Record<string, unknown>>(
  endpoint: string,
  body?: unknown,
  headers: Record<string, string> = {},
  method?: "DELETE",
): Promise<T> {
  if (!config.bankingId || !config.bankingKeyPath)
    throw new AppError(
      "Configure the Enable Banking application ID and signing key.",
      503,
    );
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ typ: "JWT", alg: "RS256", kid: config.bankingId })}.${encode({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: now, exp: now + 300 })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const token = `${unsigned}.${signer.sign(await readFile(config.bankingKeyPath)).toString("base64url")}`;
  const response = await fetch(`https://api.enablebanking.com${endpoint}`, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) {
    const code = data.error || data.code;
    if (response.status === 429)
      throw new AppError(
        "The bank has reached its request limit. The background job will retry later.",
        429,
      );
    if (
      /SESSION|CONSENT/.test(String(code)) ||
      (response.status === 401 && /SESSION/.test(String(code)))
    )
      throw new AppError(
        "Bank consent has expired or was revoked. Reconnect this bank.",
        410,
      );
    if (response.status === 401 || response.status === 403)
      throw new AppError(
        "Enable Banking did not authorize this request. Check application access and linked accounts.",
        502,
      );
    throw new AppError(
      `The bank connection is temporarily unavailable${typeof code === "string" && /^[A-Z_]+$/.test(code) ? ` (${code})` : ""}. Please retry.`,
      502,
    );
  }
  return data as T;
}
export async function availableBanks(country = "EE"): Promise<Bank[]> {
  if (!/^[A-Z]{2}$/.test(country))
    throw new AppError("Choose a valid country.");
  const cacheKey = `banks:${country}`;
  const [cached] = await query(
    "SELECT value FROM settings WHERE key=$1 AND updated_at>now()-interval '1 hour'",
    [cacheKey],
  );
  if (cached) return cached.value;
  const { aspsps } = await bankingRequest<{ aspsps: Bank[] }>(
    `/aspsps?country=${country}`,
  );
  const banks = aspsps.filter((bank) => bank.psu_types?.includes("personal"));
  await query(
    "INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()",
    [cacheKey, JSON.stringify(banks)],
  );
  return banks;
}
export async function startBankAuthorization(
  bankName: string,
  country: string,
  ownerSession: string,
) {
  const bank = (await availableBanks(country)).find(
    (bank) => bank.name === bankName,
  );
  if (!bank)
    throw new AppError(
      "This bank is not available for personal accounts in the selected country.",
    );
  const state = secretToken();
  const validUntil = new Date(
    Date.now() +
      Math.min(bank.maximum_consent_validity, 180 * 24 * 3600) * 1000,
  ).toISOString();
  await query(
    "INSERT INTO bank_states(state_hash,session_hash,bank,valid_until,expires_at) VALUES($1,$2,$3,$4,now()+interval '20 minutes')",
    [digest(state), ownerSession, JSON.stringify(bank), validUntil],
  );
  const response = await bankingRequest<{ url: string }>("/auth", {
    access: { valid_until: validUntil },
    aspsp: { name: bank.name, country: bank.country },
    state,
    redirect_url: config.bankingRedirect,
    psu_type: "personal",
  });
  const target = new URL(response.url);
  if (target.protocol !== "https:")
    throw new AppError(
      "The bank returned an invalid authorization address.",
      502,
    );
  return { url: response.url };
}
type SessionResponse = {
  session_id: string;
  access: { valid_until: string };
  accounts: Array<{
    uid: string;
    identification_hash: string;
    currency?: string;
    name?: string;
    account_id?: { iban?: string };
    details?: string;
  }>;
};
export async function completeBankAuthorization(
  state: string,
  code: string,
  ownerSession: string,
  error?: string,
) {
  const pending = await transaction(async (db) => {
    const [value] = await query(
      "UPDATE bank_states SET used_at=now() WHERE state_hash=$1 AND session_hash=$2 AND used_at IS NULL AND expires_at>now() RETURNING *",
      [digest(state), ownerSession],
      db,
    );
    if (!value)
      throw new AppError(
        "This bank authorization has expired or was already used. Start a new connection.",
      );
    return value;
  });
  if (error)
    throw new AppError(
      "Bank authorization was cancelled or declined. You can connect again.",
    );
  if (!code)
    throw new AppError("The bank did not return an authorization code.");
  const response = await bankingRequest<SessionResponse>("/sessions", { code });
  const id = await transaction(async (db) => {
    const [connection] = await query(
      `INSERT INTO bank_connections(bank_name,country,bank_metadata,session_cipher,valid_until)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(bank_name,country) DO UPDATE SET bank_metadata=excluded.bank_metadata,
      session_cipher=excluded.session_cipher,valid_until=excluded.valid_until,status='active',last_error=NULL RETURNING id`,
      [
        pending.bank.name,
        pending.bank.country,
        JSON.stringify(pending.bank),
        encrypt({ id: response.session_id }),
        response.access?.valid_until || pending.valid_until,
      ],
      db,
    );
    await db.query(
      "UPDATE accounts SET provider_uid=NULL WHERE connection_id=$1",
      [connection.id],
    );
    for (const account of response.accounts) {
      // A shared IBAN can represent different currency wallets.
      const identity = `${account.identification_hash}:${account.currency || "MULTI"}`;
      await db.query(
        `INSERT INTO accounts(connection_id,identification_hash,provider_uid,iban,name,currency)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(identification_hash) DO UPDATE SET connection_id=excluded.connection_id,
        provider_uid=excluded.provider_uid,iban=excluded.iban,name=excluded.name,currency=excluded.currency`,
        [
          connection.id,
          identity,
          account.uid,
          account.account_id?.iban || null,
          account.name || account.details || pending.bank.name,
          account.currency || null,
        ],
      );
    }
    if (!response.accounts.length)
      await db.query("UPDATE bank_connections SET last_error=$1 WHERE id=$2", [
        "No linked accounts were returned. Link each intended account in Enable Banking, then reconnect.",
        connection.id,
      ]);
    return connection.id as string;
  });
  await enqueue("bank-sync", { connectionId: id }, id);
  return id;
}
export function bankFingerprint(raw: BankTransaction): string {
  return digest(
    JSON.stringify([
      [
        raw.transaction_amount.currency.toUpperCase(),
        parseMoney(
          raw.transaction_amount.amount,
          raw.transaction_amount.currency.toUpperCase(),
        ),
      ],
      raw.credit_debit_indicator,
      raw.booking_date || raw.transaction_date || raw.value_date,
      raw.creditor?.name || raw.debtor?.name || "",
      raw.remittance_information || [],
      raw.reference_number || "",
      raw.end_to_end_id || "",
      raw.status || "BOOK",
    ]),
  );
}
export async function importBankTransactions(
  accountId: string,
  records: BankTransaction[],
  db: DB = pool,
) {
  const ownIbans = new Set(
    (
      await query(
        "SELECT DISTINCT iban FROM accounts WHERE iban IS NOT NULL",
        [],
        db,
      )
    ).map((a) => a.iban.replace(/\s/g, "").toUpperCase()),
  );
  const occurrences = new Map<string, number>();
  const bookedIds = new Set<string>();
  let count = 0;
  for (const raw of records) {
    const currency = raw.transaction_amount.currency.toUpperCase();
    const magnitude = Math.abs(
      parseMoney(raw.transaction_amount.amount, currency),
    );
    if (!magnitude) continue;
    const amount =
      raw.credit_debit_indicator === "DBIT" ? -magnitude : magnitude;
    const description = (raw.remittance_information || []).join(" · ").trim();
    const merchant =
      (raw.credit_debit_indicator === "DBIT"
        ? raw.creditor?.name
        : raw.debtor?.name) ||
      raw.creditor?.name ||
      raw.debtor?.name ||
      (raw.status === "PDNG" ? description : "") ||
      "Bank transaction";
    const sourceDate =
      raw.booking_date || raw.transaction_date || raw.value_date;
    if (!sourceDate && raw.status !== "PDNG")
      throw new AppError(
        "The bank returned a transaction without a date. The import was not committed; retry or contact the bank.",
        502,
      );
    const bookedAt = sourceDate ? validDate(sourceDate.slice(0, 10)) : null;
    const counterparty =
      (raw.credit_debit_indicator === "DBIT"
        ? raw.creditor_account?.iban
        : raw.debtor_account?.iban) || null;
    const kind = transactionKind(
      raw.credit_debit_indicator,
      `${merchant} ${description}`,
      Boolean(
        counterparty &&
        ownIbans.has(counterparty.replace(/\s/g, "").toUpperCase()),
      ),
      raw.bank_transaction_code?.code,
    );
    const fingerprint = bankFingerprint(raw);
    const ordinal = (occurrences.get(fingerprint) || 0) + 1;
    occurrences.set(fingerprint, ordinal);
    const key = raw.entry_reference
      ? `ref:${raw.entry_reference}`
      : `fp:${fingerprint}:${ordinal}`;
    const [entry] = await query(
      `INSERT INTO transactions(account_id,source_key,source_reference,fingerprint,amount,currency,kind,status,booked_at,value_at,merchant,description,counterparty_iban,mcc,raw)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT(account_id,source_key) DO UPDATE SET amount=excluded.amount,currency=excluded.currency,
      kind=CASE WHEN transactions.manual THEN transactions.kind ELSE excluded.kind END,status=excluded.status,
      booked_at=excluded.booked_at,value_at=excluded.value_at,merchant=excluded.merchant,description=excluded.description,
      counterparty_iban=excluded.counterparty_iban,mcc=excluded.mcc,raw=excluded.raw,updated_at=now()
      RETURNING id,manual,(xmax=0) AS inserted`,
      [
        accountId,
        key,
        raw.entry_reference || null,
        fingerprint,
        amount,
        currency,
        kind,
        raw.status || "BOOK",
        bookedAt,
        raw.value_date?.slice(0, 10) || null,
        merchant,
        description,
        counterparty,
        raw.merchant_category_code || null,
        JSON.stringify(raw),
      ],
      db,
    );
    await db.query(
      "INSERT INTO transaction_revisions(transaction_id,payload_hash,raw) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [entry.id, digest(JSON.stringify(raw)), JSON.stringify(raw)],
    );
    if ((raw.status || "BOOK") === "BOOK") bookedIds.add(entry.id);
    if (entry.manual) {
      const existing = await query(
        "SELECT * FROM allocations WHERE transaction_id=$1",
        [entry.id],
        db,
      );
      const expected = ["expense", "refund", "investment", "pension"].includes(
        kind,
      )
        ? -amount
        : 0;
      if (existing.reduce((sum, a) => sum + a.amount, 0) !== expected) {
        const [actual] = await query(
          "SELECT kind FROM transactions WHERE id=$1",
          [entry.id],
          db,
        );
        const allocationAmount = [
          "expense",
          "refund",
          "investment",
          "pension",
        ].includes(actual.kind)
          ? -amount
          : 0;
        if (existing.length && allocationAmount) {
          const shares = prorateLocal(
            existing.map((a) => a.amount),
            allocationAmount,
          );
          for (let i = 0; i < existing.length; i++)
            await db.query(
              "UPDATE allocations SET amount=$1 WHERE transaction_id=$2 AND category_id=$3",
              [shares[i], entry.id, existing[i].category_id],
            );
        }
      }
    } else await applyAllocations(entry.id, db);
    if (entry.inserted) count++;
  }
  for (const id of bookedIds) await settlePendingPayment(id, db);
  return count;
}
async function settlePendingPayment(entryId: string, db: DB) {
  const [entry] = await query(
    "SELECT * FROM transactions WHERE id=$1 AND status='BOOK' FOR UPDATE",
    [entryId],
    db,
  );
  if (!entry) return;
  const accountId = entry.account_id,
    amount = entry.amount,
    currency = entry.currency,
    merchant = entry.merchant,
    description = entry.description,
    bookedAt = entry.booked_at;
  // Pending rows are never counted. Supersede only an unambiguous predecessor.
  const pending = await query(
    `SELECT * FROM transactions WHERE account_id=$1 AND status='PDNG' AND amount=$2 AND currency=$3 AND (booked_at IS NULL OR booked_at BETWEEN $4::date-7 AND $4::date+1) FOR UPDATE`,
    [accountId, amount, currency, bookedAt],
    db,
  );
  const merchantText = (value: string) =>
    normalize(value)
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const bookedMerchant = merchantText(`${merchant} ${description}`);
  const candidates = pending.filter((row) => {
    const pendingMerchant = merchantText(
      row.merchant === "Bank transaction" ? row.description : row.merchant,
    );
    return (
      pendingMerchant.length >= 3 &&
      ` ${bookedMerchant} `.includes(` ${pendingMerchant} `)
    );
  });
  if (candidates.length === 1) {
    const predecessor = candidates[0];
    // Check both directions after the full import: two equal booked charges
    // must not claim the same pending receipt merely because one arrived first.
    const booked = await query(
      `SELECT id,merchant,description FROM transactions WHERE account_id=$1 AND status='BOOK' AND amount=$2 AND currency=$3
          AND booked_at BETWEEN $4::date-1 AND $4::date+7`,
      [
        accountId,
        amount,
        currency,
        predecessor.booked_at || predecessor.value_at || bookedAt,
      ],
      db,
    );
    const pendingMerchant = merchantText(
      predecessor.merchant === "Bank transaction"
        ? predecessor.description
        : predecessor.merchant,
    );
    if (
      booked.filter((row) =>
        ` ${merchantText(`${row.merchant} ${row.description}`)} `.includes(
          ` ${pendingMerchant} `,
        ),
      ).length !== 1
    )
      return;
    const links = await query(
      "SELECT * FROM receipt_payments WHERE transaction_id=$1",
      [predecessor.id],
      db,
    );
    const existingLinks = await query(
      "SELECT * FROM receipt_payments WHERE transaction_id=$1",
      [entry.id],
      db,
    );
    const linkedAmount = [...links, ...existingLinks].reduce(
      (sum, link) => sum + link.amount,
      0,
    );
    if (linkedAmount <= Math.abs(amount)) {
      if (predecessor.receipt_not_required)
        await db.query(
          "UPDATE transactions SET receipt_not_required=true WHERE id=$1",
          [entry.id],
        );
      if (predecessor.manual && !entry.manual) {
        await db.query(
          "UPDATE transactions SET kind=$2,manual=true,note=$3 WHERE id=$1",
          [entry.id, predecessor.kind, predecessor.note],
        );
        const allocations = await query(
          "SELECT * FROM allocations WHERE transaction_id=$1",
          [predecessor.id],
          db,
        );
        await db.query("DELETE FROM allocations WHERE transaction_id=$1", [
          entry.id,
        ]);
        for (const allocation of allocations)
          await db.query(
            "INSERT INTO allocations(transaction_id,category_id,amount,source) VALUES($1,$2,$3,$4)",
            [
              entry.id,
              allocation.category_id,
              allocation.amount,
              allocation.source,
            ],
          );
        entry.manual = true;
      }
      await db.query("DELETE FROM receipt_payments WHERE transaction_id=$1", [
        predecessor.id,
      ]);
      for (const link of links) {
        const existingLink = existingLinks.find(
          (existing) => existing.receipt_id === link.receipt_id,
        );
        await linkReceipt(
          link.receipt_id,
          entry.id,
          link.amount + (existingLink?.amount || 0),
          link.automatic && (existingLink?.automatic ?? true),
          db,
        );
      }
      await db.query(
        "UPDATE transactions SET status='SUPERSEDED' WHERE id=$1",
        [predecessor.id],
      );
    }
  }
}
import { prorate as prorateLocal } from "../lib/money";
export async function syncBank(
  connectionId: string,
  psuHeaders: Record<string, string> = {},
) {
  const db = await pool.connect();
  const [lock] = await query(
    "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
    [`bank:${connectionId}`],
    db,
  );
  if (!lock.locked) {
    db.release();
    return;
  }
  const [run] = await query(
    "INSERT INTO import_runs(type,source_id) VALUES('bank',$1) RETURNING id",
    [connectionId],
    db,
  );
  await db.query(
    "UPDATE bank_connections SET last_attempt_at=now() WHERE id=$1",
    [connectionId],
  );
  try {
    const [connection] = await query(
      "SELECT * FROM bank_connections WHERE id=$1",
      [connectionId],
      db,
    );
    if (!connection || connection.status === "disconnected") {
      await db.query(
        "UPDATE import_runs SET status='complete',finished_at=now() WHERE id=$1",
        [run.id],
      );
      return;
    }
    if (new Date(connection.valid_until).valueOf() <= Date.now())
      throw new AppError("Bank consent has expired. Reconnect this bank.", 410);
    const accounts = await query(
      "SELECT * FROM accounts WHERE connection_id=$1 AND provider_uid IS NOT NULL",
      [connectionId],
      db,
    );
    let count = 0;
    for (const account of accounts) {
      const base = new URLSearchParams(
        account.last_sync_at
          ? {
              date_from: new Date(
                new Date(account.last_sync_at).valueOf() - 14 * 86400000,
              )
                .toISOString()
                .slice(0, 10),
              date_to: new Intl.DateTimeFormat("sv-SE", {
                timeZone: "Europe/Tallinn",
              }).format(new Date()),
              strategy: "default",
            }
          : { strategy: "longest" },
      );
      let cursor: string | null = null,
        pages = 0;
      const records: BankTransaction[] = [];
      const pendingCounts = new Map<string, number>();
      const sebPendingSnapshot = /\bSEB\b/i.test(connection.bank_name);
      do {
        const params = new URLSearchParams(base);
        if (cursor) params.set("continuation_key", cursor);
        const data = await bankingRequest<{
          transactions: BankTransaction[];
          continuation_key?: string;
        }>(
          `/accounts/${encodeURIComponent(account.provider_uid)}/transactions?${params}`,
          undefined,
          psuHeaders,
        );
        // SEB repeats its complete pending list on every history page.
        // Keep the largest per-page multiplicity, preserving distinct identical
        // purchases returned together on one page.
        const pagePendingCounts = new Map<string, number>();
        for (const record of data.transactions) {
          if (record.status === "PDNG" && sebPendingSnapshot) {
            const key = record.entry_reference
              ? `ref:${record.entry_reference}`
              : bankFingerprint(record);
            const occurrence = (pagePendingCounts.get(key) || 0) + 1;
            pagePendingCounts.set(key, occurrence);
            if (occurrence <= (pendingCounts.get(key) || 0)) {
              continue;
            }
            pendingCounts.set(key, occurrence);
          }
          records.push(record);
        }
        cursor = data.continuation_key || null;
        if (++pages > 1000 || records.length > 100000)
          throw new AppError(
            "The bank history import reached its safety limit. Retry with a shorter date range.",
            502,
          );
        if (!data.transactions.length && cursor)
          await new Promise((resolve) => setTimeout(resolve, 300));
      } while (cursor);
      await transaction(async (tx) => {
        if (sebPendingSnapshot) {
          // The complete SEB pending snapshot also replaces old reference-less
          // copies that have disappeared or booked since the previous import.
          // Retire these before settlement so obsolete copies cannot make a
          // protected pending receipt or manual correction appear ambiguous.
          const keys = [...pendingCounts].flatMap(([fingerprint, n]) =>
            fingerprint.startsWith("ref:")
              ? []
              : Array.from(
                  { length: n },
                  (_, i) => `fp:${fingerprint}:${i + 1}`,
                ),
          );
          await tx.query(
            `UPDATE transactions t SET status='SUPERSEDED',updated_at=now() WHERE account_id=$1 AND status='PDNG'
            AND source_key LIKE 'fp:%' AND NOT (source_key=ANY($2::text[])) AND NOT manual AND NOT receipt_not_required
            AND (booked_at IS NULL OR $3::date IS NULL OR booked_at >= $3::date)
            AND NOT EXISTS(SELECT 1 FROM receipt_payments p WHERE p.transaction_id=t.id)`,
            [account.id, keys, base.get("date_from")],
          );
        }
        count += await importBankTransactions(account.id, records, tx);
        const dates = records
          .map((t) => t.booking_date || t.transaction_date || t.value_date)
          .filter(Boolean)
          .sort();
        await tx.query(
          `UPDATE accounts SET last_sync_at=now(),history_from=LEAST(history_from,$2::date),history_to=GREATEST(history_to,$3::date) WHERE id=$1`,
          [
            account.id,
            dates[0]?.slice(0, 10) || null,
            dates.at(-1)?.slice(0, 10) || null,
          ],
        );
      });
      try {
        const balances = await bankingRequest(
          `/accounts/${encodeURIComponent(account.provider_uid)}/balances`,
          undefined,
          psuHeaders,
        );
        await db.query("UPDATE accounts SET balance=$2 WHERE id=$1", [
          account.id,
          JSON.stringify(balances),
        ]);
      } catch {
        /* Transaction synchronization remains successful if only balances are unavailable. */
      }
    }
    await transaction(async (tx) => {
      for (const receipt of await query(
        "SELECT id FROM receipts WHERE status='ready'",
        [],
        tx,
      ))
        await autoMatchReceipt(receipt.id, tx);
    });
    await db.query(
      "UPDATE bank_connections SET last_sync_at=now(),last_error=NULL,status='active' WHERE id=$1",
      [connectionId],
    );
    await db.query(
      "UPDATE import_runs SET status='complete',count=$2,finished_at=now() WHERE id=$1",
      [run.id, count],
    );
  } catch (error) {
    const message = publicError(error);
    await db.query(
      "UPDATE bank_connections SET last_error=$2,status=CASE WHEN $3 THEN 'expired' ELSE status END WHERE id=$1",
      [
        connectionId,
        message,
        error instanceof AppError && error.status === 410,
      ],
    );
    await db.query(
      "UPDATE import_runs SET status='error',error=$2,finished_at=now() WHERE id=$1",
      [run.id, message],
    );
    throw error;
  } finally {
    await db.query("SELECT pg_advisory_unlock(hashtext($1))", [
      `bank:${connectionId}`,
    ]);
    db.release();
  }
}
