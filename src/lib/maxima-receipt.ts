import { parseMoney, validDate } from "./money";
import { productCategory } from "./classification";
import type { ParsedReceipt, ReceiptItem, Retailer } from "./types";

export function parseMaximaReceipt(
  text: string,
  hint?: Retailer,
): ParsedReceipt | null {
  if (hint !== "maxima" && !/\bmaxima\b/i.test(text)) return null;
  const lines = text.split("\n").map((line) =>
    line
      .replace(/&#(?:x0*a|0*10);/gi, " ")
      .trim()
      .replace(/\s+/g, " "),
  );
  const items: ReceiptItem[] = [],
    issues: string[] = [];
  const money = (value?: string) => {
    try {
      return parseMoney(value || "", "EUR");
    } catch {
      return null;
    }
  };
  const amountPattern = "([−-]?\\d+[.,]\\d{2})\\s*(?:€|EUR)?";
  const rowPattern = new RegExp(
    `^(.+?)\\s+(\\d+(?:[.,]\\d+)?)\\s+(tk|kg|g|l)\\s+${amountPattern}$`,
    "i",
  );
  const number =
    lines.map((line) => line.match(/^Nr\.\s*([\w/-]+)$/i)).find(Boolean)?.[1] ||
    null;
  let inBasket = false,
    current: ReceiptItem | null = null;
  for (const line of lines) {
    if (/^Nr\./i.test(line)) {
      inBasket = true;
      continue;
    }
    if (!inBasket || !line) continue;
    if (
      /^(?:KM\s*%|KM\b|ilma KM-ta\b|Kokku\b|Makstud\b|Maksevahend\b|Ostu kuup[äa]ev\b)/i.test(
        line,
      )
    ) {
      inBasket = false;
      continue;
    }
    if (/^Soodustus\b/i.test(line)) {
      const discount = line.match(
        new RegExp(`^Soodustus\\s+${amountPattern}$`, "i"),
      );
      const amount = money(discount?.[1]);
      if (current && amount !== null && amount < 0) {
        items.push({
          description: `Soodustus · ${current.description}`,
          quantity: null,
          unit: null,
          amount,
          categoryId: current.categoryId,
          manual: false,
        });
      } else issues.push("A Maxima product discount could not be read.");
      current = null;
      continue;
    }
    const row = line.match(rowPattern);
    if (row) {
      const unitPrice = money(row[4]);
      const quantity = row[2].replace(",", ".");
      const decimals = quantity.split(".")[1]?.length || 0;
      const divisor = 10n ** BigInt(decimals);
      // Prices are per unit, even for piece counts. Round fractional weights
      // to cents with integer arithmetic before reconciling the basket.
      const amount =
        unitPrice === null
          ? null
          : Number(
              (BigInt(unitPrice) * BigInt(quantity.replace(".", "")) +
                divisor / 2n) /
                divisor,
            );
      if (amount === null || !Number.isSafeInteger(amount)) {
        issues.push("A Maxima product amount could not be read.");
        continue;
      }
      current = {
        description: row[1],
        quantity,
        unit: row[3].toLowerCase(),
        amount,
        categoryId: /^Pet pudel\b/i.test(row[1])
          ? "deposits"
          : productCategory(row[1]),
        manual: false,
      };
      items.push(current);
    } else if (
      current &&
      !/\d+(?:[.,]\d+)?\s+(?:tk|kg|g|l)\s+\S+\s*(?:€|EUR)?$/i.test(line)
    ) {
      // The PDF places the amount on the first name line and emits encoded
      // newlines in continuations, e.g. "Natur-" followed by "al&#xA;Care".
      current.description = current.description.endsWith("-")
        ? current.description.slice(0, -1) + line
        : `${current.description} ${line}`;
      current.categoryId = productCategory(current.description);
    } else {
      issues.push("A Maxima product row could not be read.");
      current = null;
    }
  }
  const printed = (label: string) => {
    const pattern = new RegExp(`^${label}\\s*:?\\s+${amountPattern}$`, "i");
    const rows = lines.filter((line) =>
      new RegExp(`^${label}\\b`, "i").test(line),
    );
    const amounts = rows.map((line) => money(line.match(pattern)?.[1]));
    if (amounts.some((amount) => amount === null))
      issues.push("A Maxima receipt amount could not be read.");
    return amounts.length
      ? amounts.reduce<number>((sum, amount) => sum + (amount || 0), 0)
      : null;
  };
  const total = printed("Kokku"),
    paid = printed("Makstud");
  const payment = (method: string) => {
    const rows = lines.filter((line) =>
      new RegExp(`^Maksevahend\\s+${method}\\b`, "i").test(line),
    );
    const amounts = rows.map((line) =>
      money(line.match(new RegExp(`${amountPattern}$`, "i"))?.[1]),
    );
    if (amounts.some((amount) => amount === null))
      issues.push("A Maxima payment amount could not be read.");
    return amounts.length
      ? amounts.reduce<number>((sum, amount) => sum + (amount || 0), 0)
      : null;
  };
  const cardAmount = payment("Pangakaardiga"),
    cashAmount = payment("Sularahas?");
  const discounts = printed("Allahindlus kokku");
  if (
    discounts !== null &&
    items
      .filter((item) => item.amount < 0)
      .reduce((sum, item) => sum + item.amount, 0) !== discounts
  )
    issues.push(
      "The Maxima discount summary does not reconcile with the extracted discounts.",
    );
  const date = text.match(
    /Ostu kuup[äa]ev\s*:\s*(\d{2})\.(\d{2})\.(\d{4}|\d{2})\b/i,
  );
  let purchasedAt: string | null = null;
  try {
    purchasedAt = validDate(
      date
        ? `${date[3].length === 2 ? "20" : ""}${date[3]}-${date[2]}-${date[1]}`
        : "",
    );
  } catch {
    /* Reviewed below. */
  }
  if (!purchasedAt) issues.push("Purchase date is missing or invalid.");
  if (!number) issues.push("The Maxima receipt number was not found.");
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
    (paid !== total ||
      (cardAmount === null && cashAmount === null) ||
      (cardAmount || 0) + (cashAmount || 0) !== total)
  )
    issues.push("Payment amounts do not reconcile with the receipt total.");
  return {
    retailer: "maxima",
    merchant: "Maxima",
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
