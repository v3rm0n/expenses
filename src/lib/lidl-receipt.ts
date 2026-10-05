import { parseMoney, validDate } from "./money";
import { productCategory } from "./classification";
import type { ParsedReceipt, ReceiptItem } from "./types";

export function parseLidlReceipt(text: string): ParsedReceipt | null {
  if (
    !/\blidl\b/i.test(text) ||
    !/^\d{7}\s+.+/m.test(text) ||
    !/\d+[.,]\d{2}\s+x\s+\d/i.test(text)
  )
    return null;
  const items: ReceiptItem[] = [],
    issues: string[] = [];
  const money = (value?: string) => {
    try {
      return parseMoney(value || "", "EUR");
    } catch {
      return null;
    }
  };
  let description: string | null = null,
    current: ReceiptItem | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine
      .trim()
      .replace(/\s+/g, " ")
      .replace(
        /(\s[x×*]\s+)[|Il](?=\s+tk\.?\b)/g,
        (_, prefix: string) => `${prefix}1`,
      );
    if (
      /^(?:KM\b|={3,}|Vahesumma\b|Tasuda\b|Makstud\b)/i.test(line) &&
      items.length
    )
      break;
    const product = line.match(/^\d{7}\s+(.+)$/);
    if (product) {
      if (description) issues.push("A Lidl product price could not be read.");
      description = product[1];
      current = null;
      continue;
    }
    const price = line.match(
      /^([−-]?\d+[.,]\d{2})\s*[x×*]\s*(\d+(?:[.,]\d+)?)\s*(tk\.?|kg|g|l)\s+([−-]?\d+[.,]\d{2})\s*[A-Z]?$/i,
    );
    if (price && description) {
      const amount = money(price[4]);
      if (amount === null) {
        issues.push("A Lidl product amount could not be read.");
        continue;
      }
      current = {
        description,
        quantity: price[2].replace(",", "."),
        unit: price[3].toLowerCase().replace(/\.$/, ""),
        amount,
        categoryId: productCategory(description),
        manual: false,
      };
      items.push(current);
      description = null;
      continue;
    }
    const discount = line.match(
      /^(?:(?:Lidl Plus\s+)?Allahindlus\s*:?\s*|[-−]\s*)([−-]?\d+[.,]\d{2})$/i,
    );
    if (discount) {
      const amount = money(discount[1]);
      if (current && amount !== null && amount < 0) {
        items.push({
          description: `Allahindlus · ${current.description}`,
          quantity: null,
          unit: null,
          amount,
          categoryId: current.categoryId,
          manual: false,
        });
      } else issues.push("A Lidl product discount could not be reconciled.");
      continue;
    }
    // Lõpphind repeats the product minus its explicit discounts. Small PNGs
    // often OCR its leading zero as 9; use the primary price/discount rows,
    // then require their sum to match Tasuda and the payment instead.
    if (/^L[õo]pphind\b/i.test(line)) continue;
    if (description && line && !/^[-=]+$/.test(line)) description += ` ${line}`;
  }
  if (description) issues.push("A Lidl product price could not be read.");
  const total = money(text.match(/^Tasuda\s+([−-]?[\d.,]+)\s*$/im)?.[1]);
  const cardAmount = money(
    text.match(/^Makstud\s*\(pangakaart\)\s+([−-]?[\d.,]+)\s*$/im)?.[1],
  );
  const cashAmount = money(
    text.match(/^Makstud\s*\(sularaha\)\s+([−-]?[\d.,]+)\s*$/im)?.[1],
  );
  const number = text.match(/T[šs]eki\s+nr\.?\s*([\w/-]+)/i)?.[1] || null;
  const date = text.match(/\b(\d{2})\.(\d{2})\.(20\d{2})\b/);
  let purchasedAt: string | null = null;
  try {
    purchasedAt = validDate(date ? `${date[3]}-${date[2]}-${date[1]}` : "");
  } catch {
    /* Reviewed below. */
  }
  if (!purchasedAt) issues.push("Purchase date is missing or invalid.");
  if (!number) issues.push("The Lidl receipt number was not found.");
  if (total === null) issues.push("Receipt total was not found.");
  if (!items.length) issues.push("No product lines were recognized.");
  if (
    total !== null &&
    items.reduce((sum, item) => sum + item.amount, 0) !== total
  )
    issues.push(
      "Product amounts do not reconcile with the receipt total. Review the extracted lines.",
    );
  const subtotal = money(text.match(/^Vahesumma\s+([−-]?[\d.,]+)\s*$/im)?.[1]);
  const discounts = money(
    text.match(/^Allahindlus kokku\s+([−-]?[\d.,]+)\s*$/im)?.[1],
  );
  if (
    subtotal !== null &&
    items
      .filter((item) => item.amount >= 0)
      .reduce((sum, item) => sum + item.amount, 0) !== subtotal
  )
    issues.push(
      "The Lidl product subtotal does not reconcile with the extracted lines.",
    );
  if (
    discounts !== null &&
    items
      .filter((item) => item.amount < 0)
      .reduce((sum, item) => sum + item.amount, 0) !== discounts
  )
    issues.push(
      "The Lidl discount summary does not reconcile with the extracted discounts.",
    );
  if (
    total !== null &&
    (cardAmount !== null || cashAmount !== null) &&
    (cardAmount || 0) + (cashAmount || 0) !== total
  )
    issues.push("Payment amounts do not reconcile with the receipt total.");
  return {
    retailer: "lidl",
    merchant: "Lidl",
    number,
    purchasedAt,
    currency: "EUR",
    total,
    cardAmount,
    cashAmount,
    items,
    valid: issues.length === 0,
    issues,
    text,
  };
}
