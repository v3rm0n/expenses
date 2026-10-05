import { parseMoney, prorate, validDate } from "./money";
import { productCategory } from "./classification";
import type { ParsedReceipt, ReceiptItem, Retailer } from "./types";

export function parseAmazonReceipt(
  text: string,
  hint?: Retailer,
): ParsedReceipt | null {
  if (hint !== "amazon" && !/amazon\.(?:de|com)|Amazon EU\s+S/i.test(text))
    return null;
  const issues: string[] = [];
  const items: ReceiptItem[] = [];
  const credit = /^\s*(?:Gutschrift|Credit note|Credit memo)\s*$/im.test(text);
  const currency = text.match(/\b(EUR|GBP|USD)\b/)?.[1] || "EUR";
  const money = (value: string) =>
    parseMoney(value.replace("−", "-"), currency);
  const number =
    text.match(
      /(?:Rechnungsnummer|Invoice number|Gutschriftsnummer|Credit (?:note|memo) number)\s*:?\s*([A-Z0-9][A-Z0-9-]+)/i,
    )?.[1] || null;
  const orderId = text.match(
    /(?:Bestellnummer|Order number|Order ID)\s*:?\s*(\d{3}-\d{7}-\d{7})/i,
  )?.[1];
  const dateText = text.match(
    /(?:Rechnungsdatum|Invoice date|Gutschriftsdatum|Credit (?:note|memo) date)(?:\s*\/\s*(?:Lieferdatum|Delivery date))?\s*:?\s*(\d{1,2}\s+[\p{L}]+\s+20\d{2}|\d{1,2}[./]\d{1,2}[./]20\d{2}|20\d{2}-\d{2}-\d{2})/iu,
  )?.[1];
  let purchasedAt: string | null = null;
  if (dateText) {
    const words = dateText.match(/^(\d{1,2})\s+([\p{L}]+)\s+(20\d{2})$/u);
    const numeric = dateText.match(/^(\d{1,2})[./](\d{1,2})[./](20\d{2})$/);
    const months = [
      "januar|january",
      "februar|february",
      "märz|march",
      "april",
      "mai|may",
      "juni|june",
      "juli|july",
      "august",
      "september",
      "oktober|october",
      "november",
      "dezember|december",
    ];
    const month = words
      ? months.findIndex((m) => new RegExp(`^(?:${m})$`, "i").test(words[2])) +
        1
      : 0;
    const iso =
      words && month
        ? `${words[3]}-${String(month).padStart(2, "0")}-${words[1].padStart(2, "0")}`
        : numeric
          ? `${numeric[3]}-${numeric[2].padStart(2, "0")}-${numeric[1].padStart(2, "0")}`
          : dateText;
    try {
      purchasedAt = validDate(iso);
    } catch {
      /* Reviewed below. */
    }
  }
  let total: number | null = null;
  const payable = text.match(
    /(?:Zahlbetrag|Amount payable|Total payable|Erstattungsbetrag)\s+([−-]?[\d.,]+)\s*(?:€|EUR|GBP|USD)/i,
  );
  let inTable = false;
  let pending: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/\s+/g, " ");
    if (
      /^(?:Beschreibung|Description)\b/i.test(line) &&
      /Menge|Quantity/i.test(line)
    ) {
      inTable = true;
      continue;
    }
    if (!inTable || !line) continue;
    if (
      /^(?:Gesamtpreis|Gesamtbetrag|Invoice total|Total(?: price)?|Gutschriftbetrag)\b/i.test(
        line,
      )
    ) {
      const amount = line.match(/([−-]?[\d.,]+)\s*(?:€|EUR|GBP|USD)\s*$/i);
      if (amount) total = money(amount[1]);
      if (pending.length)
        issues.push("An Amazon product line could not be read.");
      break;
    }
    if (
      /^(?:ASIN\s*:|\(?ohne USt|\(?inkl\. USt|\(?excl\.? VAT|\(?incl\.? VAT|USt\.|VAT\b|Seite \d|Page \d|Rechnung$|Invoice$)/i.test(
        line,
      )
    )
      continue;
    const amounts = [
      ...line.matchAll(
        /([−-]?\d+(?:[.,]\d{3})*[.,]\d{2})\s*(?:€|EUR|GBP|USD)/g,
      ),
    ];
    if (!amounts.length) {
      pending.push(line);
      continue;
    }
    const prefix = line.slice(0, amounts[0].index).trim();
    const quantity = prefix.match(/^(.*?)\s+(\d+)$/);
    const description = [...pending, quantity ? quantity[1] : prefix]
      .join(" ")
      .trim();
    pending = [];
    if (!description) {
      issues.push("An Amazon product description could not be read.");
      continue;
    }
    const amount = money(amounts.at(-1)![1]);
    items.push({
      description,
      quantity: quantity?.[2] || null,
      unit: quantity ? "pcs" : null,
      amount,
      categoryId: /windel|diaper|huggies|pampers/i.test(description)
        ? "household"
        : productCategory(description),
      manual: false,
    });
  }
  if (total !== null && payable && money(payable[1]) !== total)
    issues.push("The Amazon invoice total and payable amount disagree.");
  // Distribute delivery and basket discounts across the actual products.
  const products = items.filter(
    (item) =>
      item.amount > 0 &&
      !/^(?:Versandkosten|Shipping|Delivery|Postage)\b/i.test(item.description),
  );
  const extras = items.filter(
    (item) =>
      item.amount < 0 ||
      /^(?:Versandkosten|Shipping|Delivery|Postage)\b/i.test(item.description),
  );
  if (products.length)
    for (const extra of extras) {
      const shares = prorate(
        products.map((item) => item.amount),
        extra.amount,
      );
      const index = items.indexOf(extra);
      items.splice(
        index,
        1,
        ...products.flatMap((product, i) =>
          shares[i]
            ? [
                {
                  ...extra,
                  description: `${extra.description} · ${product.description}`,
                  amount: shares[i],
                  categoryId: product.categoryId,
                },
              ]
            : [],
        ),
      );
    }
  if (credit && total !== null && total > 0) {
    total = -total;
    items.forEach((item) => {
      item.amount = -item.amount;
    });
  }
  if (!number) issues.push("The Amazon invoice number could not be read.");
  if (!purchasedAt) issues.push("The Amazon invoice date could not be read.");
  if (!orderId) issues.push("The Amazon order number could not be read.");
  if (
    total === null ||
    !items.length ||
    items.reduce((sum, item) => sum + item.amount, 0) !== total
  )
    issues.push(
      "The Amazon invoice products do not reconcile with its total. Review the original PDF.",
    );
  return {
    retailer: "amazon",
    merchant: "Amazon.de",
    number,
    orderId,
    purchasedAt,
    currency,
    total,
    cardAmount: total,
    cashAmount: null,
    items,
    valid: !issues.length,
    issues,
    text,
  };
}
