import { lockImportWindow, removeReceipts } from "./import-window";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { query, transaction, type DB } from "./db";
import { digest } from "./crypto";
import { AppError, publicError } from "./errors";
import { parseReceipt } from "../lib/receipt-parser";
import { normalize, matchingRule } from "../lib/classification";
import type { Retailer, Rule } from "../lib/types";
import { enqueue } from "./queue";
import { applyAllocations, autoMatchReceipt } from "./ledger";
import type { ReceiptOrderContext } from "../lib/wolt-receipt";

export const MAX_FILE_SIZE = 15 * 1024 * 1024;
export function detectFile(buffer: Buffer, filename: string) {
  if (buffer.subarray(0, 5).toString() === "%PDF-")
    return { extension: "pdf", mime: "application/pdf" };
  if (
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { extension: "png", mime: "image/png" };
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255)
    return { extension: "jpg", mime: "image/jpeg" };
  if (/\.txt$/i.test(filename) && !buffer.includes(0))
    return { extension: "txt", mime: "text/plain" };
  if (/\.csv$/i.test(filename) && !buffer.includes(0))
    return { extension: "csv", mime: "text/csv" };
  throw new AppError(
    "Upload a PDF, PNG, JPEG, CSV, text receipt, or .eml email.",
  );
}
export function storageFile(relative: string) {
  const resolved = path.resolve(config.dataDir, relative);
  if (!resolved.startsWith(`${config.dataDir}${path.sep}`))
    throw new AppError("Invalid document path.", 403);
  return resolved;
}
export async function storeReceipt(
  buffer: Buffer,
  filename: string,
  hint: Retailer = "unknown",
  source = "upload",
  order?: ReceiptOrderContext,
) {
  if (!buffer.length || buffer.length > MAX_FILE_SIZE)
    throw new AppError("Each receipt must be between 1 byte and 15 MB.");
  const type = detectFile(buffer, filename),
    hash = digest(buffer);
  const [existing] = await query(
    "SELECT id,duplicate_of,order_id,order_total,order_currency FROM receipts WHERE file_hash=$1",
    [hash],
  );
  if (existing) {
    if (order) {
      if (
        (existing.order_id && existing.order_id !== order.orderId) ||
        (existing.order_total !== null &&
          existing.order_total !== order.total) ||
        (existing.order_currency && existing.order_currency !== order.currency)
      )
        throw new AppError(
          "This receipt was already associated with a different order total. Review the original email.",
        );
      await query(
        "UPDATE receipts SET order_id=$2,order_total=$3,order_currency=$4,order_document_count=greatest(order_document_count,$6),retailer=CASE WHEN manual THEN retailer ELSE $5 END,status=CASE WHEN NOT manual AND status='review' THEN 'processing' ELSE status END WHERE id=$1",
        [
          existing.id,
          order.orderId,
          order.total,
          order.currency,
          order.retailer || "wolt",
          order.documentCount || null,
        ],
      );
      await enqueue("receipt-parse", { receiptId: existing.id }, existing.id);
    }
    return { id: existing.duplicate_of || existing.id, duplicate: true };
  }
  const relative = `receipts/${hash}.${type.extension}`;
  await mkdir(path.dirname(storageFile(relative)), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(storageFile(relative), buffer, { mode: 0o600 });
  const [receipt] = await query(
    `INSERT INTO receipts(file_hash,filename,content_type,storage_path,retailer,source,order_id,order_total,order_currency,order_document_count)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(file_hash) DO UPDATE SET file_hash=excluded.file_hash RETURNING id`,
    [
      hash,
      path
        .basename(filename)
        .replace(/[\x00-\x1f]/g, "")
        .slice(0, 200),
      type.mime,
      relative,
      hint,
      source,
      order?.orderId || null,
      order?.total ?? null,
      order?.currency || null,
      order?.documentCount || null,
    ],
  );
  await enqueue("receipt-parse", { receiptId: receipt.id }, receipt.id);
  return { id: receipt.id, duplicate: false };
}
export async function deleteReceipt(id: string) {
  return transaction(async (db) => {
    // Wait for parsing and imports before deleting a canonical receipt and
    // its duplicates, so a parser cannot add a reference during deletion.
    await lockImportWindow(db, true);
    const [receipt] = await query(
      "SELECT id FROM receipts WHERE id=$1 FOR UPDATE",
      [id],
      db,
    );
    if (!receipt) throw new AppError("Receipt not found.", 404);
    const removedReceipts = await removeReceipts([id], db);
    await db.query(
      "INSERT INTO corrections(entity,entity_id,change) VALUES('receipt',$1,'{\"deleted\":true}')",
      [id],
    );
    return { removedReceipts };
  });
}

async function recognizeImage(buffer: Buffer): Promise<string> {
  const { createWorker } = await import("tesseract.js");
  const cachePath = path.join(config.dataDir, "ocr");
  await mkdir(cachePath, { recursive: true, mode: 0o700 });
  const worker = await createWorker(["eng", "est"], undefined, { cachePath });
  try {
    const { data } = await worker.recognize(buffer);
    return data.text;
  } finally {
    await worker.terminate();
  }
}
export async function extractDocument(
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  if (contentType === "text/plain" || contentType === "text/csv")
    return buffer.toString("utf8");
  if (contentType.startsWith("image/")) return recognizeImage(buffer);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  });
  const document = await loadingTask.promise;
  try {
    if (document.numPages > 20)
      throw new AppError("A receipt PDF may contain at most 20 pages.");
    const pages: string[] = [];
    for (let i = 1; i <= document.numPages; i++) {
      const page = await document.getPage(i),
        content = await page.getTextContent();
      const lines: Array<{
        y: number;
        parts: Array<{ x: number; text: string }>;
      }> = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const y = item.transform[5],
          x = item.transform[4];
        let line = lines.find((line) => Math.abs(line.y - y) < 3);
        if (!line) {
          line = { y, parts: [] };
          lines.push(line);
        }
        line.parts.push({ x, text: item.str });
      }
      let text = lines
        .sort((a, b) => b.y - a.y)
        .map((line) =>
          line.parts
            .sort((a, b) => a.x - b.x)
            .map((p) => p.text)
            .join(" "),
        )
        .join("\n");
      if (text.replace(/\s/g, "").length < 25) {
        const { createCanvas } = await import("@napi-rs/canvas");
        const viewport = page.getViewport({ scale: 2 });
        if (viewport.width * viewport.height > 30_000_000)
          throw new AppError("This scanned page is too large to process.");
        const canvas = createCanvas(
          Math.ceil(viewport.width),
          Math.ceil(viewport.height),
        );
        await page.render({
          canvas: canvas as never,
          canvasContext: canvas.getContext("2d") as never,
          viewport,
        }).promise;
        text = await recognizeImage(canvas.toBuffer("image/png"));
      }
      pages.push(text);
      page.cleanup();
    }
    return pages.join("\n");
  } finally {
    await loadingTask.destroy();
  }
}
export async function processReceipt(id: string) {
  const [receipt] = await query("SELECT * FROM receipts WHERE id=$1", [id]);
  if (!receipt || receipt.manual || receipt.duplicate_of) return;
  const [run] = await query(
    "INSERT INTO import_runs(type,source_id) VALUES('receipt',$1) RETURNING id",
    [id],
  );
  let skipped = false;
  try {
    const text = await extractDocument(
      await readFile(storageFile(receipt.storage_path)),
      receipt.content_type,
    );
    const parsed = parseReceipt(text, receipt.retailer as Retailer);
    if (
      receipt.order_id &&
      (parsed.orderId !== receipt.order_id ||
        (receipt.order_currency && parsed.currency !== receipt.order_currency))
    ) {
      parsed.valid = false;
      parsed.issues.push(
        "The receipt order ID or currency differs from its import. Review the documents.",
      );
    }
    await transaction(async (db) => {
      const startDate = await lockImportWindow(db);
      const [current] = await query(
        "SELECT manual FROM receipts WHERE id=$1 FOR UPDATE",
        [id],
        db,
      );
      if (!current || current.manual) return;
      if (parsed.purchasedAt && parsed.purchasedAt < startDate) {
        await removeReceipts([id], db);
        skipped = true;
        return;
      }
      const identity =
        parsed.number && parsed.purchasedAt
          ? digest(
              JSON.stringify([
                parsed.retailer,
                parsed.merchant,
                parsed.number,
                parsed.purchasedAt,
                parsed.currency,
              ]),
            )
          : null;
      if (identity) {
        await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          identity,
        ]);
        const [duplicate] = await query(
          "SELECT id,total FROM receipts WHERE receipt_identity=$1 AND id<>$2",
          [identity, id],
          db,
        );
        if (duplicate && duplicate.total === parsed.total) {
          await db.query(
            "UPDATE receipts SET status='duplicate',duplicate_of=$2,text=$3 WHERE id=$1",
            [id, duplicate.id, text],
          );
          return;
        }
        if (duplicate) {
          parsed.valid = false;
          parsed.issues.push(
            "An existing receipt has the same number and date but a different total. Review both documents.",
          );
        }
      }
      const rules = await query<Rule>(
        "SELECT * FROM rules WHERE enabled ORDER BY priority",
        [],
        db,
      );
      const mappings = await query(
        "SELECT product,category_id FROM product_mappings WHERE retailer=$1",
        [parsed.retailer],
        db,
      );
      const oldItems = await query(
        "SELECT description,category_id,manual FROM receipt_items WHERE receipt_id=$1",
        [id],
        db,
      );
      for (const item of parsed.items) {
        const previous = oldItems.find(
          (old) =>
            old.manual &&
            normalize(old.description) === normalize(item.description),
        );
        const mapping = mappings.find(
          (mapping) => mapping.product === normalize(item.description),
        );
        const rule = matchingRule(
          rules.filter((rule) => rule.field === "product"),
          parsed.merchant,
          "",
          item.description,
        );
        item.categoryId =
          previous?.category_id ||
          mapping?.category_id ||
          rule?.category_id ||
          item.categoryId;
        item.manual = Boolean(previous?.manual || mapping);
      }
      await db.query(
        `UPDATE receipts SET retailer=$2,merchant=$3,receipt_number=$4,purchased_at=$5,currency=$6,total=$7,
        card_amount=$8,cash_amount=$9,text=$10,issues=$11,status=$12,receipt_identity=$13,order_id=coalesce(order_id,$14),error=NULL,updated_at=now() WHERE id=$1`,
        [
          id,
          parsed.retailer,
          parsed.merchant,
          parsed.number,
          parsed.purchasedAt,
          parsed.currency,
          parsed.total,
          parsed.cardAmount,
          parsed.cashAmount,
          parsed.text,
          JSON.stringify(parsed.issues),
          parsed.valid ? "ready" : "review",
          parsed.issues.some((issue) => issue.startsWith("An existing receipt"))
            ? null
            : identity,
          parsed.orderId || null,
        ],
      );
      await replaceReceiptItems(
        id,
        parsed.items.map((item) => ({ ...item, category_id: item.categoryId })),
        db,
      );
      for (const link of await query(
        "SELECT transaction_id FROM receipt_payments WHERE receipt_id=$1",
        [id],
        db,
      ))
        await applyAllocations(link.transaction_id, db);
      if (parsed.valid) {
        if (
          (
            await query(
              "SELECT 1 FROM receipt_payments WHERE receipt_id=$1",
              [id],
              db,
            )
          ).length
        )
          await db.query("UPDATE receipts SET status='matched' WHERE id=$1", [
            id,
          ]);
        else await autoMatchReceipt(id, db);
      }
    });
    await query(
      "UPDATE import_runs SET status='complete',count=$2,finished_at=now() WHERE id=$1",
      [run.id, skipped ? 0 : 1],
    );
  } catch (error) {
    await query(
      "UPDATE receipts SET status='review',error=$2,updated_at=now() WHERE id=$1",
      [
        id,
        error instanceof AppError
          ? error.message
          : "The document could not be read. Retry or enter the receipt details manually.",
      ],
    );
    await query(
      "UPDATE import_runs SET status='error',error=$2,finished_at=now() WHERE id=$1",
      [run.id, publicError(error)],
    );
    throw error;
  }
}
export async function replaceReceiptItems(
  id: string,
  items: Array<{
    description: string;
    quantity?: string | null;
    unit?: string | null;
    amount: number;
    category_id: string;
    manual?: boolean;
  }>,
  db: DB,
) {
  await db.query("DELETE FROM receipt_items WHERE receipt_id=$1", [id]);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    await db.query(
      "INSERT INTO receipt_items(receipt_id,position,description,quantity,unit,amount,category_id,manual) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        id,
        i,
        item.description,
        item.quantity || null,
        item.unit || null,
        item.amount,
        item.category_id,
        Boolean(item.manual),
      ],
    );
  }
}
