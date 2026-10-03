import { parseMoney, validDate } from "./money";
import { productCategory } from "./classification";
import type { ParsedReceipt, ReceiptItem } from "./types";

export type ReceiptOrderContext = {
  orderId: string;
  total: number;
  currency: string;
};
const clean = (text: string) =>
  text.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
export function woltEmailOrder(text: string): ReceiptOrderContext | null {
  text = clean(text);
  if (!/\bwolt\b/i.test(text)) return null;
  const orderId = text.match(/\bOrder ID\s*:\s*([a-f\d]{24})\b/i)?.[1];
  const total = text.match(/^\s*Total\s+([A-Z]{3})\s+([\d.,]+)\s*$/im);
  if (!orderId || !total) return null;
  try {
    return {
      orderId: orderId.toLowerCase(),
      currency: total[1].toUpperCase(),
      total: parseMoney(total[2], total[1].toUpperCase()),
    };
  } catch {
    return null;
  }
}

export function parseWoltReceipt(text: string): ParsedReceipt | null {
  if (
    !/\bwolt\b/i.test(text) ||
    !/Item\s+VAT\s+%\s+Quantity\s+Gross unit price\s+Price/i.test(text)
  )
    return null;
  text = clean(text);
  const lines = text.split("\n").map((line) => line.trim());
  const issues: string[] = [],
    items: ReceiptItem[] = [];
  const totalLine = text.match(
    /^Total in ([A-Z]{3})\s*\(incl\. VAT\)\s+([−-]?[\d.,]+)\s*$/im,
  );
  const currency = totalLine?.[1].toUpperCase() || "EUR";
  const money = (value?: string) => {
    try {
      return parseMoney(value || "", currency);
    } catch {
      return null;
    }
  };
  const venue = text.match(/^Venue\s+(.+)$/im)?.[1];
  const groceries = /wolt market|rimi|selver|coop|lidl/i.test(venue || "");
  const orderId = text
    .match(/^Order ID\s+([a-f\d]{24})\s*$/im)?.[1]
    .toLowerCase();
  const date = text.match(/^Delivery time\s+(\d{2})\.(\d{2})\.(20\d{2})\b/im);
  let purchasedAt: string | null = null;
  try {
    purchasedAt = validDate(date ? `${date[3]}-${date[2]}-${date[1]}` : "");
  } catch {
    /* Reviewed below. */
  }
  let inTable = false,
    pending: string[] = [];
  for (const line of lines) {
    if (/^Item\s+VAT\s+%\s+Quantity\s+Gross unit price\s+Price$/i.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable || !line) continue;
    if (/^Total in\b/i.test(line)) break;
    const row = line.match(
      /^(.*?)\s*(\d+(?:[.,]\d+)?)%\s+([−-]?\d+(?:[.,]\d+)?)\s+([−-]?\d+[.,]\d{2})\s+([−-]?\d+[.,]\d{2})$/,
    );
    if (!row) {
      // Display-only net prices and discount previews repeat table amounts.
      if (!/[−-]?\d+[.,]\d{2}\s*$/.test(line)) pending.push(line);
      continue;
    }
    const prefix = row[1].trim();
    const previous = items.at(-1);
    if (prefix && previous && pending.length)
      previous.description += ` ${pending.join(" ")}`;
    const description = prefix || pending.join(" ");
    pending = [];
    const amount = money(row[5]);
    if (!description || amount === null) {
      issues.push("A Wolt product line could not be read.");
      continue;
    }
    const discount = /discount/i.test(description) && amount < 0;
    items.push({
      description,
      quantity: row[3].replace(",", "."),
      unit: null,
      amount,
      categoryId:
        discount && previous
          ? previous.categoryId
          : groceries
            ? productCategory(description) === "uncategorized"
              ? "groceries"
              : productCategory(description)
            : "restaurants",
      manual: false,
    });
  }
  if (pending.length && items.length)
    items[items.length - 1].description += ` ${pending.join(" ")}`;
  for (const item of items) {
    const repeated = item.description.match(/^(.{20,}?)\s+\1$/u);
    if (repeated) item.description = repeated[1];
  }
  const total = money(totalLine?.[2]);
  const paymentLines = lines.slice(
    0,
    lines.findIndex((line) => /^Item\s+VAT\b/i.test(line)),
  );
  let cardAmount: number | null = null,
    cashAmount: number | null = null;
  for (const line of paymentLines) {
    const payment = line.match(
      /^(Apple Pay|Google Pay|Card|Visa|Mastercard|Cash)\s+([−-]?[\d.,]+)$/i,
    );
    if (!payment) continue;
    const amount = money(payment[2]);
    if (amount === null)
      issues.push("The Wolt payment amount could not be read.");
    else if (/cash/i.test(payment[1])) cashAmount = (cashAmount || 0) + amount;
    else cardAmount = (cardAmount || 0) + amount;
  }
  const number =
    text.match(/^(?:Wolt delivery )?Receipt\s*#\s*(\S+)/im)?.[1] || null;
  if (!number) issues.push("The Wolt receipt number was not found.");
  if (!orderId) issues.push("The Wolt order ID was not found.");
  if (!purchasedAt) issues.push("Purchase date is missing or invalid.");
  if (total === null) issues.push("Receipt total was not found.");
  if (!items.length) issues.push("No product lines were recognized.");
  if (
    total !== null &&
    items.reduce((sum, item) => sum + item.amount, 0) !== total
  )
    issues.push(
      "Product amounts do not reconcile with the receipt total. Review the extracted lines.",
    );
  if (
    total !== null &&
    (cardAmount !== null || cashAmount !== null) &&
    (cardAmount || 0) + (cashAmount || 0) !== total
  )
    issues.push("Payment amounts do not reconcile with the receipt total.");
  return {
    retailer: "wolt",
    merchant: venue ? `Wolt · ${venue}` : "Wolt",
    number,
    orderId,
    purchasedAt,
    currency,
    total,
    cardAmount,
    cashAmount,
    items,
    valid: issues.length === 0,
    issues,
    text,
  };
}
