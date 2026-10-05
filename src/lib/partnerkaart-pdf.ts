import { productCategory } from "./classification";
import { parseMoney, validDate } from "./money";
import { finalizePartnerkaartReceipt } from "./partnerkaart-csv";
import type { ParsedReceipt, Retailer } from "./types";

export function parsePartnerkaartPdf(
  text: string,
  hint?: Retailer,
): ParsedReceipt | null {
  const header = /^Toode\s+Kogus\s+[ÜU]hiku hind\s+Kokku$/i;
  const lines = text
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "));
  if (
    !lines.some((line) => header.test(line)) ||
    !(
      hint === "partnerkaart" ||
      /selver|partnerkaart|delice|kaubamaja/i.test(text)
    )
  )
    return null;
  const result: ParsedReceipt = {
    retailer: "partnerkaart",
    merchant: /selver/i.test(text)
      ? "Selver"
      : /delice/i.test(text)
        ? "Delice"
        : /kaubamaja/i.test(text)
          ? "Kaubamaja"
          : "Selver / Partnerkaart",
    number: text.match(/T[šs]eki?\s+nr\.?\s*[:.]?\s*([\w/-]+)/i)?.[1] || null,
    purchasedAt: null,
    currency: "EUR",
    total: null,
    cardAmount: null,
    cashAmount: null,
    items: [],
    valid: false,
    issues: [],
    text,
  };
  const date = text.match(/Kuup[äa]ev\s+(\d{2})[./](\d{2})[./](20\d{2})/i);
  try {
    result.purchasedAt = validDate(
      date ? `${date[3]}-${date[2]}-${date[1]}` : "",
    );
  } catch {
    /* Validated below. */
  }
  const money = (value: string) => {
    try {
      return parseMoney(value, "EUR");
    } catch {
      return null;
    }
  };
  const amount = "([−-]?\\d+[.,]\\d{2})\\s*(?:€|EUR)?";
  const totalPattern = new RegExp(`^Kokku\\s+${amount}$`, "i");
  const rowPattern = new RegExp(
    `^(.+?)\\s+([−-]?\\d+(?:[.,]\\d+)?)\\s+${amount}\\s+${amount}$`,
    "i",
  );
  let basket = false,
    foundBasket = false,
    closedBasket = false,
    bonus = 0;
  let pending: string[] = [];
  const totals: number[] = [];
  for (const line of lines) {
    if (!line) continue;
    if (header.test(line)) {
      basket = true;
      foundBasket = true;
      continue;
    }
    const total = line.match(totalPattern);
    if (total) {
      const value = money(total[1]);
      if (value !== null) totals.push(value);
      if (foundBasket) closedBasket = true;
      basket = false;
      continue;
    }
    if (/^Kokku\b/i.test(line)) {
      result.issues.push("A Selver PDF receipt total could not be read.");
      basket = false;
      continue;
    }
    if (/^(?:Sinu v[õo]it kokku|Makseviis)\b/i.test(line)) {
      basket = false;
      continue;
    }
    if (/^---\s*Kampaania v[õo]it\b.*---$/i.test(line)) continue;
    if (basket) {
      const row = line.match(rowPattern);
      if (!row) {
        pending.push(line);
        continue;
      }
      const description = [...pending, row[1]].join(" ");
      pending = [];
      const value = money(row[4]);
      const quantity = row[2].replace(",", ".");
      if (
        !/[\p{L}]/u.test(description) ||
        value === null ||
        Number(quantity) === 0 ||
        !Number.isFinite(Number(quantity))
      ) {
        result.issues.push(
          "A Selver PDF product name, quantity, or amount could not be read.",
        );
        continue;
      }
      // The final column already includes campaign discounts; the unit price
      // and following campaign-savings line must not be charged again.
      result.items.push({
        description,
        quantity,
        unit: null,
        amount: value,
        categoryId: productCategory(description),
        manual: false,
      });
      continue;
    }
    const payment = line.match(
      /^(Boonusmakse|Partner[ÄA]pp makse|Pangakaart|Kaardimakse|Sularaha)(?:\s+(.*))?$/i,
    );
    if (payment) {
      const value = money((payment[2] || "").replace(/\s*(?:€|EUR)\s*$/i, ""));
      if (value === null || value < 0)
        result.issues.push("A receipt payment amount could not be read.");
      else if (/^Boonusmakse$/i.test(payment[1])) bonus += value;
      else if (/^Sularaha$/i.test(payment[1]))
        result.cashAmount = (result.cashAmount || 0) + value;
      else result.cardAmount = (result.cardAmount || 0) + value;
    }
  }
  if (!closedBasket || pending.length)
    result.issues.push(
      "A Selver PDF product row or basket total could not be read.",
    );
  result.total = totals[0] ?? null;
  if (totals.some((value) => value !== result.total))
    result.issues.push("The Selver PDF receipt totals do not agree.");
  if (result.cardAmount === null && result.cashAmount === null && !bonus)
    result.issues.push("Receipt payment amounts were not found.");
  return finalizePartnerkaartReceipt(result, bonus, "PDF header");
}
