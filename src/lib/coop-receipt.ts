import { parseMoney, validDate } from "./money";
import { productCategory } from "./classification";
import type { ParsedReceipt, ReceiptItem, Retailer } from "./types";

export function parseCoopReceipt(
  text: string,
  hint?: Retailer,
): ParsedReceipt | null {
  if (
    !/^Toode\s+Kogus\s+Kokku\s*$/im.test(text) ||
    !(
      hint === "coop" ||
      /\bcoop\b|konsum|maksimarket|tarbijate\s+[üu]histu/i.test(text)
    )
  )
    return null;
  const lines = text
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "));
  const issues: string[] = [],
    items: ReceiptItem[] = [];
  const money = (value?: string) => {
    try {
      return parseMoney(value || "", "EUR");
    } catch {
      return null;
    }
  };
  const amountPattern = "([−-]?\\d+(?:[ .,]\\d{3})*[.,]\\d{2})\\s*(?:€|EUR)?";
  const totalPattern = new RegExp(`^Kokku\\s+${amountPattern}\\s*$`, "i");
  const summaryPattern = new RegExp(`^Summa\\s+${amountPattern}\\s*$`, "i");
  const rowPattern = new RegExp(
    `^(.+?)\\s+([−-]?\\d+(?:[.,]\\d+)?)\\s+${amountPattern}\\s*$`,
  );
  const header = lines.findIndex((line) =>
    /^Toode\s+Kogus\s+Kokku$/i.test(line),
  );
  const totals: number[] = [];
  let inBasket = false,
    pending: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    if (/^Toode\s+Kogus\s+Kokku$/i.test(line)) {
      inBasket = true;
      continue;
    }
    const total = line.match(totalPattern);
    if (total) {
      const amount = money(total[1]);
      if (amount !== null) totals.push(amount);
      inBasket = false;
      continue;
    }
    if (!inBasket) continue;
    if (/^(?:KM\s*%|Käibemaks|Makseviis|T[šs]ekk\s+nr|Kuupäev)\b/i.test(line)) {
      inBasket = false;
      issues.push(
        "The Coop basket total was not found before the receipt footer.",
      );
      continue;
    }
    const row = line.match(rowPattern);
    if (!row) {
      pending.push(line);
      continue;
    }
    const amount = money(row[3]);
    const description = [...pending, row[1]].join(" ");
    pending = [];
    if (amount === null) {
      issues.push("A Coop product amount could not be read.");
      continue;
    }
    items.push({
      description,
      quantity: row[2].replace(",", "."),
      unit: null,
      amount,
      categoryId: productCategory(description),
      manual: false,
    });
  }
  if (pending.length) issues.push("A Coop product row could not be read.");
  const total = totals[0] ?? null;
  if (total === null) issues.push("Receipt total was not found.");
  if (totals.some((value) => value !== total))
    issues.push("The Coop receipt totals do not agree.");
  const summary = lines.map((line) => line.match(summaryPattern)).find(Boolean);
  if (summary && money(summary[1]) !== total)
    issues.push("The Coop header amount differs from the basket total.");
  if (!items.length) issues.push("No product lines were recognized.");
  if (
    total !== null &&
    items.reduce((sum, item) => sum + item.amount, 0) !== total
  )
    issues.push(
      "Product amounts do not reconcile with the receipt total. Review the extracted lines.",
    );
  const payment = (label: string) => {
    const pattern = new RegExp(`^${label}\\s+${amountPattern}\\s*$`, "i");
    const amounts = lines
      .map((line) => line.match(pattern))
      .filter((match) => match !== null)
      .map((match) => money(match[1]));
    if (amounts.some((amount) => amount === null))
      issues.push("A Coop payment amount could not be read.");
    return amounts.length
      ? amounts.reduce<number>((sum, amount) => sum + (amount || 0), 0)
      : null;
  };
  const cardAmount = payment("(?:Kaart|Pangakaart|Kaardimakse)"),
    cashAmount = payment("(?:Sularaha|Cash)");
  if (
    total !== null &&
    (cardAmount !== null || cashAmount !== null) &&
    (cardAmount || 0) + (cashAmount || 0) !== total
  )
    issues.push("Payment amounts do not reconcile with the receipt total.");
  const number = text.match(/T[šs]ekk\s+nr\.?\s+([\w/-]+)/i)?.[1] || null;
  const date = text.match(/Kuup[äa]ev\s+(\d{2})[./-](\d{2})[./-](20\d{2})\b/i);
  let purchasedAt: string | null = null;
  try {
    purchasedAt = validDate(date ? `${date[3]}-${date[2]}-${date[1]}` : "");
  } catch {
    /* Reviewed below. */
  }
  if (!purchasedAt) issues.push("Purchase date is missing or invalid.");
  if (!number) issues.push("The Coop receipt number was not found.");
  const store = lines
    .slice(0, header)
    .find((line) => /konsum|maksimarket|\bcoop\b/i.test(line));
  return {
    retailer: "coop",
    merchant: store ? `Coop · ${store}` : "Coop",
    number,
    purchasedAt,
    currency: "EUR",
    total,
    cardAmount,
    cashAmount,
    items,
    issues,
    valid: issues.length === 0,
    text,
  };
}
