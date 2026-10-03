import { parseMoney, prorate, validDate } from "./money";
import { productCategory } from "./classification";
import type { ParsedReceipt, Retailer, ReceiptItem } from "./types";
import { parsePartnerkaartCsv } from "./partnerkaart-csv";
import { parseWoltReceipt } from "./wolt-receipt";
import { parseLidlReceipt } from "./lidl-receipt";
import { parseCoopReceipt } from "./coop-receipt";

const profiles: Record<
  Retailer,
  { merchant: string; total: RegExp; ignore: RegExp }
> = {
  wolt: {
    merchant: "Wolt",
    total: /^total\b/i,
    ignore: /^(?:VAT|Net price|Seller details|Business ID|Address)/i,
  },
  rimi: {
    merchant: "Rimi",
    total: /^(?:kokku|tasuda|maksta|total|summa kokku)\b/i,
    ignore:
      /^(?:rimi raha|sinu rimi|boonus|käibemaks|km\b|vat|maksustatav|säästsid|sääst kokku|hind kokku)/i,
  },
  partnerkaart: {
    merchant: "Selver / Partnerkaart",
    total: /^(?:kokku|tasuda|maksta|total|summa kokku)\b/i,
    ignore:
      /^(?:boonus|partnerkaart|partnerkaardi|käibemaks|km\b|vat|maksustatav|säästsid|soodustus kokku)/i,
  },
  coop: {
    merchant: "Coop",
    total: /^(?:kokku|tasuda|maksta|total|summa kokku)\b/i,
    ignore:
      /^(?:säästukaart|sääst kokku|boonus|käibemaks|km\b|vat|maksustatav|coop pluss)/i,
  },
  lidl: {
    merchant: "Lidl",
    total: /^(?:kokku|tasuda|maksta|total|summe|summa)\b/i,
    ignore:
      /^(?:lidl plus|säästsid|käibemaks|km\b|vat|ust\b|mwst|maksustatav|savings)/i,
  },
  unknown: {
    merchant: "Unknown merchant",
    total: /^(?:kokku|tasuda|maksta|total|summe|summa kokku)\b/i,
    ignore: /^(?:käibemaks|km\b|vat|maksustatav|boonus)/i,
  },
};
function detectRetailer(text: string): Retailer {
  if (/\bwolt\b/i.test(text)) return "wolt";
  if (/\blidl\b/i.test(text)) return "lidl";
  if (/\brimi\b/i.test(text)) return "rimi";
  if (/partnerkaart|selver|delice|kaubamaja/i.test(text)) return "partnerkaart";
  if (/\bcoop\b|maksimarket|konsum|säästukaart/i.test(text)) return "coop";
  return "unknown";
}
function lastAmount(line: string, currency: string): number | null {
  const match = line.match(
    /([−-]?\d+(?:[ .,]\d{3})*[.,]\s*\d{2,3})\s*(?:€|EUR|[A-Z])?\s*$/,
  );
  if (!match) return null;
  try {
    return parseMoney(match[1], currency);
  } catch {
    return null;
  }
}
// Rimi digital receipts wrap product names, print quantity/price on a separate
// line, and repeat discounts in a summary after the basket. Keep only the
// basket and use each product's printed "Uus hind" as its net line amount.
function rimiDigitalItems(text: string, currency: string) {
  const items: ReceiptItem[] = [];
  const issues: string[] = [];
  let inBasket = false;
  let pending: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine
      .trim()
      .replace(/\s+/g, " ")
      .replace(/(\d[.,])\s+(\d{2})(?=\s*(?:EUR|€|[A-Z])?\s*$)/g, "$1$2");
    if (/^KLIENT\s*:/i.test(line)) {
      inBasket = true;
      continue;
    }
    if (!inBasket || !line || /^[-_=]+$/.test(line)) continue;
    if (
      /^(?:SINU SOODUSTUSED|Oled säästnud|KAARDIMAKSE|PANGAKAART|SULARAHA|KOKKU)\b/i.test(
        line,
      )
    )
      break;
    const amount = lastAmount(line, currency);
    if (/^(?:Allah\.|Allahindlus)\s/i.test(line)) {
      const previous = items.at(-1);
      if (
        previous &&
        /(?:[UÜ]us|Tus)\s+hind\b/i.test(line) &&
        amount !== null
      ) {
        const discount = line.match(
          /^(?:Allah\.|Allahindlus)\s+([−-]?\d+[.,]\d{2})\s+_?\s*(?:[UÜ]us|Tus)\s+hind\b/i,
        );
        if (
          discount &&
          previous.amount + parseMoney(discount[1], currency) !== amount
        )
          issues.push(
            "A product discount does not reconcile with its printed new price.",
          );
        // A damaged OCR discount (e.g. -1,7%9) can still have a readable net
        // price. The complete basket must reconcile with the printed total.
        previous.amount = amount;
      } else {
        issues.push(
          "A Rimi product discount could not be read. Review the receipt.",
        );
      }
      continue;
    }
    const quantity = line.match(
      /^(\d+(?:[.,]\d+)?)\s*(kg|g|tk|pcs|l)\.?\s*[x×*]\s*([\d.,]+)(?:\s*EUR(?:\/(?:kg|g|tk|pcs|l))?)?/i,
    );
    // A basket price ends with its VAT code. Wrapped names can end in a
    // decimal volume (e.g. 0,51 after OCR), which must remain part of the name.
    if (amount === null || !/\d\s+[A-Z]\s*$/.test(line)) {
      pending.push(line);
      continue;
    }
    const description = quantity
      ? pending.join(" ")
      : [
          ...pending,
          line.replace(
            /\s+[−-]?\d+(?:[ .,]\d{3})*[.,]\d{2,3}\s*(?:€|EUR|[A-Z])?\s*$/,
            "",
          ),
        ]
          .join(" ")
          .trim();
    pending = [];
    if (!description || !/[\p{L}]/u.test(description)) {
      issues.push("A Rimi product name could not be read. Review the receipt.");
      continue;
    }
    let productAmount = amount;
    if (quantity && /^(tk|pcs)$/i.test(quantity[2])) {
      const count = Number(quantity[1].replace(",", "."));
      const unitPrice = parseMoney(quantity[3], currency);
      const expected = count * unitPrice;
      if (
        Number.isSafeInteger(count) &&
        count > 0 &&
        Number.isSafeInteger(expected) &&
        expected !== amount
      ) {
        // Tiny receipt fonts commonly turn 6,38 into 5,38. Accept only a
        // single changed digit corroborated by the printed count and unit
        // price; the complete net basket still has to match the final total.
        const printed = String(amount),
          calculated = String(expected);
        if (
          printed.length === calculated.length &&
          [...printed].filter((digit, i) => digit !== calculated[i]).length ===
            1
        )
          productAmount = expected;
        else
          issues.push(
            "A Rimi quantity and unit price do not reconcile with the product amount.",
          );
      }
    }
    items.push({
      description,
      quantity: quantity ? quantity[1].replace(",", ".") : null,
      unit: quantity ? quantity[2].toLowerCase() : null,
      amount: productAmount,
      categoryId: productCategory(description),
      manual: false,
    });
  }
  if (pending.length)
    issues.push("A Rimi product amount could not be read. Review the receipt.");
  // Product discounts are already included above; only redeemed loyalty
  // money is a further basket reduction. Repeated campaign summaries are not.
  const loyalty = text.match(
    /^Kasutatud\s+Sinu\s+RIMI\s+raha\s+([−-]\d+[.,]\s*\d{2})\s*$/im,
  );
  if (loyalty) {
    const discount = parseMoney(loyalty[1], currency);
    const products = items.filter(
      (item) => item.amount > 0 && item.categoryId !== "deposits",
    );
    if (
      products.length &&
      -discount <= products.reduce((sum, item) => sum + item.amount, 0)
    ) {
      const shares = prorate(
        products.map((item) => item.amount),
        discount,
      );
      products.forEach((item, i) => {
        item.amount += shares[i];
      });
    } else
      issues.push(
        "Redeemed Rimi loyalty money does not reconcile with the basket.",
      );
  }
  return { items, issues };
}
export function parseReceipt(text: string, hint?: Retailer): ParsedReceipt {
  text = text
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ");
  const coop = parseCoopReceipt(text, hint);
  if (coop) return coop;
  const csv = parsePartnerkaartCsv(text);
  if (csv) return csv;
  const wolt = parseWoltReceipt(text);
  if (wolt) return wolt;
  const lidl = parseLidlReceipt(text);
  if (lidl) return lidl;
  const retailer = hint && hint !== "unknown" ? hint : detectRetailer(text);
  const profile = profiles[retailer];
  const currency =
    text.match(/\b(EUR|USD|GBP|SEK|NOK|DKK|PLN|CHF)\b/i)?.[1].toUpperCase() ||
    "EUR";
  const date = text.match(/\b(\d{2})[./-](\d{2})[./-](20\d{2})\b/);
  const isoDate = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  const purchasedAt = date
    ? `${date[3]}-${date[2]}-${date[1]}`
    : isoDate
      ? isoDate[0]
      : null;
  const number =
    text.match(
      /(?:tšekk|tsekk|receipt|kviitung|ostutšekk|dokument)\s*(?:nr\.?|number|#|:)\s*([\w/-]+)/i,
    )?.[1] ||
    (retailer === "rimi"
      ? text.match(/\bARVE\s+NR\s*[:.]?\s*([\w/-]+)/i)?.[1]
      : null) ||
    null;
  let merchant = profile.merchant;
  if (retailer === "partnerkaart")
    merchant = /delice/i.test(text)
      ? "Delice"
      : /kaubamaja/i.test(text)
        ? "Kaubamaja"
        : /selver/i.test(text)
          ? "Selver"
          : profile.merchant;
  let total: number | null = null,
    cardAmount: number | null = null,
    cashAmount: number | null = null;
  const digital =
    retailer === "rimi" &&
    /^KLIENT\s*:/im.test(text) &&
    /digitaalne|SINU SOODUSTUSED|[UÜ]us hind/i.test(text)
      ? rimiDigitalItems(text, currency)
      : null;
  const items: ReceiptItem[] = digital?.items || [];
  let foundTotal = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim().replace(/\s+/g, " ");
    if (!line) continue;
    const amount = lastAmount(line, currency);
    if (profile.total.test(line) && amount !== null) {
      total = amount;
      foundTotal = true;
      continue;
    }
    if (
      /^(?:pangakaart|kaardimakse|kaart|bank card|card|visa|mastercard|deebetkaart|credit card)\b/i.test(
        line,
      )
    ) {
      if (amount !== null) cardAmount = amount;
      continue;
    }
    if (/^(?:sularaha|cash)\b/i.test(line)) {
      if (amount !== null) cashAmount = amount;
      continue;
    }
    if (digital || foundTotal || profile.ignore.test(line)) continue;
    if (
      /^(?:kuupäev|aeg|kassa|tšekk|tsekk|receipt|kviitung|reg\.?|registr|tel\b|www\.|http|e-post|aadress|klient|müüja|ostutšekk|käive|maksumäär|summa ilma|hind\b|artikkel)/i.test(
        line,
      )
    )
      continue;
    const quantity = line.match(
      /^(\d+(?:[.,]\d+)?)\s*(kg|g|tk|pcs|l)?\s*[x×*]\s*([\d.,]+)/i,
    );
    if (quantity) {
      if (items.length) {
        items[items.length - 1].quantity = quantity[1].replace(",", ".");
        items[items.length - 1].unit = quantity[2] || "tk";
      }
      continue;
    }
    if (amount === null) continue;
    let description = line
      .replace(
        /\s+[−-]?\d+(?:[ .,]\d{3})*[.,]\d{2,3}\s*(?:€|EUR|[A-Z])?\s*$/,
        "",
      )
      .trim();
    // Some exports have a unit-price column before the final line total.
    description = description.replace(/\s+\d+[.,]\d{2}\s*$/, "").trim();
    if (
      !description ||
      !/[\p{L}]/u.test(description) ||
      /^[ABCD]\s+\d/i.test(description)
    )
      continue;
    if (
      /allahindlus|discount|soodustus|kupong|coupon|sääst/i.test(description) &&
      amount < 0
    ) {
      // Basket coupons apply proportionally to the whole basket.
      if (
        /ostukorv|basket|kupong|coupon/.test(
          description.toLocaleLowerCase("et"),
        ) &&
        items.some((item) => item.amount > 0)
      ) {
        const products = items.filter((item) => item.amount > 0);
        const shares = prorate(
          products.map((item) => item.amount),
          amount,
        );
        products.forEach((product, index) => {
          if (shares[index])
            items.push({
              description: `${description} · ${product.description}`,
              quantity: null,
              unit: null,
              amount: shares[index],
              categoryId: product.categoryId,
              manual: false,
            });
        });
      } else {
        const category = items.length
          ? items[items.length - 1].categoryId
          : "uncategorized";
        items.push({
          description,
          quantity: null,
          unit: null,
          amount,
          categoryId: category,
          manual: false,
        });
      }
      continue;
    }
    items.push({
      description,
      quantity: null,
      unit: null,
      amount,
      categoryId: productCategory(description),
      manual: false,
    });
  }
  const issues: string[] = digital?.issues || [];
  const sum = items.reduce((a, item) => a + item.amount, 0);
  if (digital && cashAmount === null && cardAmount === sum) {
    const terminalAmount = lastAmount(
      text.match(/^SUMMA\s*:\s*.+$/im)?.[0] || "",
      currency,
    );
    // These scanned exports repeat the payment on the terminal slip and at
    // the receipt footer. Both independent copies and the complete basket
    // must agree before repairing an unreadable/misread KOKKU amount.
    if (terminalAmount === sum) total = sum;
  }
  if (retailer === "unknown")
    issues.push(
      "Retailer was not recognized. Choose a source or correct the receipt.",
    );
  let validPurchasedAt = purchasedAt;
  try {
    validDate(purchasedAt || "");
  } catch {
    validPurchasedAt = null;
    issues.push("Purchase date is missing or invalid.");
  }
  if (total === null) issues.push("Receipt total was not found.");
  if (!items.length) issues.push("No product lines were recognized.");
  if (total !== null && sum !== total)
    issues.push(
      "Product amounts do not reconcile with the receipt total. Review the extracted lines.",
    );
  return {
    retailer,
    merchant,
    number,
    purchasedAt: validPurchasedAt,
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
