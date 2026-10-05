import { z } from "zod";
import { AppError } from "./errors";
import { digest } from "./crypto";
import { storeReceipt, MAX_FILE_SIZE } from "./receipts";
import { validDate } from "../lib/money";

export const MAX_AMAZON_PACK_SIZE = 70 * 1024 * 1024;
const orderId = z.string().regex(/^\d{3}-\d{7}-\d{7}$/);
export async function importAmazonPack(buffer: Buffer) {
  if (buffer.length > MAX_AMAZON_PACK_SIZE)
    throw new AppError(
      "The Amazon invoice pack exceeds 70 MB. Choose a shorter period.",
      413,
    );
  let input: unknown;
  try {
    input = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new AppError("This is not a valid Amazon invoice pack.");
  }
  const pack = z
    .object({
      format: z.literal("expenses-amazon-invoices"),
      version: z.literal(1),
      from: z.string(),
      to: z.string(),
      invoices: z
        .array(
          z.object({
            orderId,
            filename: z.string().regex(/^amazon-\d{3}-\d{7}-\d{7}-\d+\.pdf$/),
            pdf: z
              .string()
              .min(8)
              .max(Math.ceil(MAX_FILE_SIZE / 3) * 4)
              .regex(/^[A-Za-z0-9+/]+={0,2}$/),
          }),
        )
        .max(300),
      missing: z.array(orderId).max(1000),
    })
    .safeParse(input);
  if (!pack.success)
    throw new AppError("This is not a valid Amazon invoice pack.");
  try {
    validDate(pack.data.from);
    validDate(pack.data.to);
  } catch {
    throw new AppError("The Amazon invoice pack has invalid order dates.");
  }
  if (pack.data.from > pack.data.to)
    throw new AppError("The Amazon invoice pack has invalid order dates.");
  // Validate every PDF before storing anything, and count distinct documents.
  const unique = new Map<
    string,
    { orderId: string; filename: string; buffer: Buffer }
  >();
  let bytes = 0;
  for (const invoice of pack.data.invoices) {
    const pdf = Buffer.from(invoice.pdf, "base64");
    if (
      pdf.subarray(0, 5).toString() !== "%PDF-" ||
      pdf.length > MAX_FILE_SIZE ||
      pdf.toString("base64") !== invoice.pdf
    )
      throw new AppError("The Amazon invoice pack contains an invalid PDF.");
    bytes += pdf.length;
    if (bytes > 50 * 1024 * 1024)
      throw new AppError("The Amazon invoice pack exceeds 50 MB of PDFs.", 413);
    const hash = digest(pdf);
    const existing = unique.get(hash);
    if (existing && existing.orderId !== invoice.orderId)
      throw new AppError("An invoice is assigned to two Amazon orders.");
    unique.set(hash, {
      orderId: invoice.orderId,
      filename: invoice.filename,
      buffer: pdf,
    });
  }
  const counts = new Map<string, number>();
  for (const invoice of unique.values())
    counts.set(invoice.orderId, (counts.get(invoice.orderId) || 0) + 1);
  const results = [];
  for (const invoice of unique.values()) {
    const result = await storeReceipt(
      invoice.buffer,
      invoice.filename,
      "amazon",
      "amazon",
      {
        orderId: invoice.orderId,
        total: null,
        currency: "EUR",
        retailer: "amazon",
        documentCount: counts.get(invoice.orderId),
      },
    );
    results.push({ filename: invoice.filename, ...result });
  }
  return { results, missing: pack.data.missing.length };
}
