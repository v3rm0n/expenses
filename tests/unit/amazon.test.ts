import { describe, expect, it } from "vitest";
import { parseReceipt } from "../../src/lib/receipt-parser";
import { amazonOrderId, amazonReceiptText, receiptText } from "../fixtures";

describe("Amazon invoices", () => {
  it("reads English identities, invoice dates and gross product totals", () => {
    const receipt = parseReceipt(amazonReceiptText());
    expect(receipt).toMatchObject({
      retailer: "amazon",
      merchant: "Amazon.de",
      number: "TEST-AMAZON-1",
      orderId: amazonOrderId,
      purchasedAt: "2026-10-02",
      currency: "EUR",
      total: 510,
      cardAmount: 510,
      valid: true,
    });
    expect(receipt.items[0]).toMatchObject({
      description: "Huggies diapers",
      quantity: "1",
      amount: 510,
      categoryId: "children",
    });
    expect(parseReceipt(receiptText()).retailer).toBe("rimi");
  });
  it("keeps shipping and its discount separate from the product discount", () => {
    const text = `Rechnung
Amazon EU S.à r.l.
Rechnungsdatum
/Lieferdatum 01 Oktober 2026
Rechnungsnummer TEST-DE-1
Zahlbetrag 30,15 €
Bestellnummer ${amazonOrderId}
Beschreibung Menge Stückpreis USt. % Stückpreis Zwischensumme
(ohne USt.) (inkl. USt.) (inkl. USt.)
Huggies Pants Extra Care
Größe 4, 80 Windeln (2x40) 1 27,02 € 24% 33,50 € 33,50 €
ASIN: TEST-ASIN
Versandkosten 11,96 € 14,82 € 14,82 €
Aktionsrabatt -14,67 € -18,17 € -18,17 €
Gesamtpreis 30,15 €`;
    const receipt = parseReceipt(text);
    expect(receipt).toMatchObject({
      valid: true,
      total: 3015,
      purchasedAt: "2026-10-01",
    });
    expect(receipt.items.map((i) => i.amount)).toEqual([
      3350, 1482, -1482, -335,
    ]);
    expect(receipt.items.map((i) => i.categoryId)).toEqual([
      "children",
      "shipping",
      "shipping",
      "children",
    ]);
  });
  it("converts a positive credit note into a refund", () => {
    const text = amazonReceiptText()
      .replace(/^Invoice\n/, "Credit note\n")
      .replace("Invoice number", "Credit note number")
      .replace("Invoice date", "Credit note date");
    expect(parseReceipt(text)).toMatchObject({
      valid: true,
      total: -510,
      cardAmount: -510,
    });
    expect(parseReceipt(text).items[0].amount).toBe(-510);
  });
  it.each([
    ["02 October 2026", "31 February 2026"],
    ["Invoice number TEST-AMAZON-1", "No invoice identifier"],
    [`Order number ${amazonOrderId}`, "Order number missing"],
    ["Invoice total 5.10", "Invoice total 5.11"],
    ["Amount payable 5.10", "Amount payable 5.09"],
    [
      "Huggies diapers 1 5.10 EUR 24% 5.10 EUR 5.10 EUR",
      "Huggies diapers unreadable",
    ],
  ])("keeps unverifiable invoices in review: %s", (before, after) => {
    expect(parseReceipt(amazonReceiptText().replace(before, after)).valid).toBe(
      false,
    );
  });
  it("recognizes an unsupported seller invoice without guessing its total", () => {
    expect(parseReceipt("Some seller\nInvoice 50.00", "amazon")).toMatchObject({
      retailer: "amazon",
      valid: false,
      total: null,
    });
  });
});
