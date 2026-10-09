import { parseMoney, prorate, validDate } from "./money";
import { normalize, productCategory } from "./classification";
import type { ParsedReceipt, ReceiptItem, Retailer } from "./types";

export type ReceiptOrderContext = {
  orderId: string;
  total: number | null;
  currency: string;
  retailer?: Retailer;
  documentCount?: number;
};
const clean = (text: string) =>
  text.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");

export function woltChargeCategory(description: string): string | null {
  const text = normalize(description);
  if (/^(?:wolt\+? )?service fee(?: discount)?$/.test(text))
    return "fees_taxes";
  if (/^(?:delivery(?: fee| charge| discount)?|tip for courier)$/.test(text))
    return "shipping";
  return null;
}

// Saved product mappings are applied after parsing. Rebuild the derived voucher
// rows afterwards so discounts reduce the final categories, excluding deposits.
export function recategorizeWoltDiscounts(items: ReceiptItem[]): ReceiptItem[] {
  let previousCategory: string | undefined;
  items = items.map((item) => {
    if (item.amount > 0) previousCategory = item.categoryId;
    if (
      /^Discount$/i.test(item.description) &&
      item.amount < 0 &&
      previousCategory
    )
      return { ...item, categoryId: previousCategory };
    return item;
  });
  const discounts = items.filter((item) =>
    /^Wolt payment discount · /.test(item.description),
  );
  if (!discounts.length) return items;
  const base = items.filter((item) => !discounts.includes(item));
  const categories = new Map<string, number>();
  for (const item of base)
    if (item.categoryId !== "deposits")
      categories.set(
        item.categoryId,
        (categories.get(item.categoryId) || 0) + item.amount,
      );
  const eligible = [...categories].filter(([, amount]) => amount > 0);
  const amount = discounts.reduce((sum, item) => sum + item.amount, 0);
  if (
    !eligible.length ||
    amount >= 0 ||
    -amount > eligible.reduce((sum, [, value]) => sum + value, 0)
  )
    return items;
  const shares = prorate(
    eligible.map(([, value]) => value),
    amount,
  );
  return [
    ...base,
    ...eligible.flatMap(([categoryId], index) =>
      shares[index]
        ? [
            {
              description: `Wolt payment discount · ${categoryId}`,
              quantity: null,
              unit: null,
              amount: shares[index],
              categoryId,
              manual: discounts.some((item) => item.manual),
            },
          ]
        : [],
    ),
  ];
}
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
  const groceries = /wolt market|rimi|selver|coop|lidl|stockmann/i.test(
    venue || "",
  );
  const category = (description: string) => {
    const product = productCategory(description);
    if (groceries) return product === "uncategorized" ? "groceries" : product;
    if (product === "deposits" || product === "gifts") return product;
    // Wine sauces and cakes belong to the meal, while separately ordered
    // alcoholic drinks are identified by their volume or alcohol strength.
    if (
      product === "alcohol" &&
      /\d\s*(?:ml|cl|l)\b|\d[.,]\d+\s*%|\bsoju\b/i.test(description)
    )
      return product;
    return "restaurants";
  };
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
      /^(.*?)\s*(\d+(?:[.,]\d+)?)%\s+([−-]?\d+(?:[.,]\d+)?)\s*(g|kg|ml|l)?\s+([−-]?\d+[.,]\d{2})(?:\/(?:g|kg|ml|l))?\s+([−-]?\d+[.,]\d{2})$/i,
    );
    if (!row) {
      // A wrapped package size belongs to the preceding product, even when
      // the next product also starts on a separate line.
      if (/^\d+(?:[.,]\d+)?\s*(?:g|kg|ml|l|tk)\b/i.test(line) && items.length) {
        items[items.length - 1].description += ` ${line}`;
        continue;
      }
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
    const amount = money(row[6]);
    if (!description || amount === null) {
      issues.push("A Wolt product line could not be read.");
      continue;
    }
    const discount = /discount/i.test(description) && amount < 0;
    items.push({
      description,
      quantity: row[3].replace(",", "."),
      unit: row[4]?.toLowerCase() || null,
      amount,
      categoryId:
        woltChargeCategory(description) ||
        (discount && previous ? previous.categoryId : category(description)),
      manual: false,
    });
  }
  if (pending.length && items.length)
    items[items.length - 1].description += ` ${pending.join(" ")}`;
  for (const item of items) {
    const repeated = item.description.match(/^(.{20,}?)\s+\1$/u);
    if (repeated) item.description = repeated[1];
  }
  let previousCategory: string | undefined;
  for (const item of items) {
    item.categoryId =
      woltChargeCategory(item.description) ||
      (/discount/i.test(item.description) && item.amount < 0 && previousCategory
        ? previousCategory
        : category(item.description));
    if (item.amount > 0) previousCategory = item.categoryId;
  }
  let total = money(totalLine?.[2]);
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
  // Payment-method discounts are funded by Wolt and excluded from the
  // seller's VAT invoice total. Use the explicitly printed discount to
  // reconcile the net spend; table discount previews are already included.
  const paymentDiscounts = paymentLines
    .filter((line) => /^(?:Discount|Wolt discount credits)\b/i.test(line))
    .map((line) =>
      money(
        line.match(/^(?:Discount|Wolt discount credits)\s+([\d.,]+)$/i)?.[1],
      ),
    );
  if (paymentDiscounts.some((amount) => amount === null))
    issues.push("The Wolt payment discount could not be read.");
  const paymentDiscount = paymentDiscounts.reduce<number>(
    (sum, amount) => sum + (amount || 0),
    0,
  );
  if (total !== null && paymentDiscount > 0) {
    const categories = new Map<string, number>();
    for (const item of items)
      if (item.categoryId !== "deposits")
        categories.set(
          item.categoryId,
          (categories.get(item.categoryId) || 0) + item.amount,
        );
    const eligible = [...categories].filter(([, amount]) => amount > 0);
    if (
      paymentDiscounts.every((amount) => amount !== null) &&
      items.reduce((sum, item) => sum + item.amount, 0) === total &&
      (cardAmount !== null || cashAmount !== null) &&
      (cardAmount || 0) + (cashAmount || 0) + paymentDiscount === total &&
      paymentDiscount < total &&
      paymentDiscount <= eligible.reduce((sum, [, amount]) => sum + amount, 0)
    ) {
      const shares = prorate(
        eligible.map(([, amount]) => amount),
        -paymentDiscount,
      );
      eligible.forEach(([categoryId], index) => {
        if (shares[index])
          items.push({
            description: `Wolt payment discount · ${categoryId}`,
            quantity: null,
            unit: null,
            amount: shares[index],
            categoryId,
            manual: false,
          });
      });
      total -= paymentDiscount;
    } else
      issues.push(
        "The Wolt payment discount does not reconcile with the invoice and payment.",
      );
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
