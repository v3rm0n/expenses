import { productCategory } from "./classification";
import { parseMoney, prorate, validDate } from "./money";
import type { ParsedReceipt, ReceiptItem } from "./types";

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (quoted || !field.trim()) quoted = !quoted;
      else field += character;
    } else if (!quoted && (character === ";" || character === "\n")) {
      row.push(field.trim());
      field = "";
      if (character === "\n") {
        rows.push(row);
        row = [];
      }
    } else field += character;
  }
  if (quoted) throw new Error("An unterminated quoted CSV field was found.");
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function parsePartnerkaartCsv(text: string): ParsedReceipt | null {
  if (
    !/(?:^|\n)\s*"?NIMETUS"?\s*;/i.test(text) ||
    !/selver|partnerkaart|delice|kaubamaja/i.test(text)
  )
    return null;
  const issues: string[] = [],
    items: ReceiptItem[] = [];
  const result: ParsedReceipt = {
    retailer: "partnerkaart",
    merchant: /selver/i.test(text)
      ? "Selver"
      : /delice/i.test(text)
        ? "Delice"
        : /kaubamaja/i.test(text)
          ? "Kaubamaja"
          : "Selver / Partnerkaart",
    number: null,
    purchasedAt: null,
    currency: "EUR",
    total: null,
    cardAmount: null,
    cashAmount: null,
    items,
    valid: false,
    issues,
    text,
  };
  let rows: string[][];
  try {
    rows = csvRows(text);
  } catch {
    issues.push(
      "The receipt CSV contains an unclosed quoted field. Export it again or correct the receipt.",
    );
    return result;
  }
  const headerIndex = rows.findIndex(
    (row) => row[0]?.toUpperCase() === "NIMETUS",
  );
  const header = (rows[headerIndex] || []).map((cell) => cell.toUpperCase());
  const nameColumn = header.indexOf("NIMETUS"),
    quantityColumn = header.indexOf("KOGUS"),
    amountColumn = header.indexOf("SUMMA");
  if ([nameColumn, quantityColumn, amountColumn].includes(-1)) {
    issues.push(
      "The receipt CSV is missing a product, quantity, or amount column.",
    );
    return result;
  }
  const money = (cell: string | undefined) => {
    try {
      return parseMoney(cell || "", "EUR");
    } catch {
      return null;
    }
  };
  let basketEnd = rows.length;
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row.some(Boolean)) continue;
    // The second KOKKU belongs to the VAT table, not the product basket.
    if (row[0].toUpperCase() === "KOKKU") {
      result.total = money(row[1]);
      basketEnd = i;
      break;
    }
    if (
      /^(?:PARTNERAPP|PANGAKAART|KAARDIMAKSE|SULARAHA|KM%|PARTNERKAARDI NR|TŠEKK|TSEKK)$/i.test(
        row[0],
      )
    ) {
      basketEnd = i - 1;
      break;
    }
    const amount = money(row[amountColumn]);
    const quantity = row[quantityColumn]?.replace(",", ".").replace(/−/g, "-");
    if (
      !row[nameColumn] ||
      amount === null ||
      !quantity ||
      !/^[+-]?\d+(?:\.\d+)?$/.test(quantity) ||
      Number(quantity) === 0 ||
      !Number.isFinite(Number(quantity))
    ) {
      issues.push(
        `Product row ${i + 1} contains an unreadable name, quantity, or amount.`,
      );
      continue;
    }
    items.push({
      description: row[nameColumn],
      quantity,
      unit: null,
      amount,
      categoryId: productCategory(row[nameColumn]),
      manual: false,
    });
  }
  let bonusAmount = 0;
  for (const row of rows.slice(basketEnd + 1)) {
    if (/^KM%$/i.test(row[0])) break;
    const card =
      /^(?:PARTNERAPP|PANGAKAART|KAARDIMAKSE|KAART|VISA|MASTERCARD)$/i.test(
        row[0],
      );
    const cash = /^(?:SULARAHA|CASH)$/i.test(row[0]);
    const bonus = /^BOONUSRAHA$/i.test(row[0]);
    if (card || cash || bonus) {
      const amount = money(row[1]);
      if (amount === null || (bonus && amount < 0))
        issues.push("A receipt payment amount could not be read.");
      else if (bonus) bonusAmount += amount;
      else if (card) result.cardAmount = (result.cardAmount || 0) + amount;
      else result.cashAmount = (result.cashAmount || 0) + amount;
    }
  }
  const metadataIndex = rows.findIndex(
    (row) => /^(?:TŠEKK|TSEKK)$/i.test(row[0]) && row.includes("KUUPÄEV"),
  );
  if (metadataIndex !== -1) {
    const metadataHeader = rows[metadataIndex];
    const metadata = rows
      .slice(metadataIndex + 1)
      .find((row) => row.some(Boolean));
    result.number = metadata?.[0] || null;
    const date = metadata?.[metadataHeader.indexOf("KUUPÄEV")]?.match(
      /^(\d{2})[./](\d{2})[./](20\d{2})$/,
    );
    try {
      result.purchasedAt = validDate(
        date ? `${date[3]}-${date[2]}-${date[1]}` : "",
      );
    } catch {
      /* Reviewed below. */
    }
  }
  return finalizePartnerkaartReceipt(result, bonusAmount);
}

// CSV and PDF exports share tender reconciliation and bonus-money allocation.
export function finalizePartnerkaartReceipt(
  result: ParsedReceipt,
  bonusAmount: number,
  identityLocation = "CSV footer",
): ParsedReceipt {
  const { items, issues } = result;
  if (!result.number)
    issues.push(`Receipt number was not found in the ${identityLocation}.`);
  if (!result.purchasedAt) issues.push("Purchase date is missing or invalid.");
  if (result.total === null) issues.push("Receipt total was not found.");
  if (!items.length) issues.push("No product lines were recognized.");
  if (
    result.total !== null &&
    items.reduce((sum, item) => sum + item.amount, 0) !== result.total
  )
    issues.push(
      "Product amounts do not reconcile with the receipt total. Review the extracted lines.",
    );
  if (
    result.total !== null &&
    (result.cardAmount !== null ||
      result.cashAmount !== null ||
      bonusAmount > 0) &&
    (result.cardAmount || 0) + (result.cashAmount || 0) + bonusAmount !==
      result.total
  )
    issues.push("Payment amounts do not reconcile with the receipt total.");
  // Match and categorize the amount actually paid, as for redeemed Rimi
  // money. Validate the original basket and tenders before reducing it.
  if (bonusAmount > 0 && issues.length === 0 && result.total !== null) {
    const products = items.filter(
      (item) => item.amount > 0 && item.categoryId !== "deposits",
    );
    if (bonusAmount > products.reduce((sum, item) => sum + item.amount, 0))
      issues.push(
        "Redeemed Partnerkaart bonus money exceeds the product total.",
      );
    else {
      const shares = prorate(
        products.map((item) => item.amount),
        -bonusAmount,
      );
      products.forEach((item, i) => {
        item.amount += shares[i];
      });
      result.total -= bonusAmount;
    }
  }
  result.valid = issues.length === 0;
  return result;
}
