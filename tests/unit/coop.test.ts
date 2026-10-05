import { describe, expect, it } from "vitest";
import { parseReceipt } from "../../src/lib/receipt-parser";
import { coopReceiptText } from "../fixtures";

describe("Coop digital receipts", () => {
  it("reads app exports with barcodes, short decimals and footer discount summaries", () => {
    const receipt = parseReceipt(`Test kauplus
Coop äpp
Ost nr: COOP-APP-1
Kuupäev: 03.10.2026 11:58
Nimetus Kogus Summa
VIRSIK KG 0.18 0.36
15033
AURA MG 0.5L 1 1.29
4740051002351
Plast 1/2 L 10 sent 1 0.1
999056
SAAR.VESI 1.5L 1 0.72
4741122000092
Plast suur 10s 1 0.1
999057
KOKKU 2.57 €
Makseviis
Kaardimakse 2.57
Soodustus
SK soodustus 0.18 €
KM 24% 1.91 € 0.46 € 2.37 €`);
    expect(receipt).toMatchObject({
      valid: true,
      merchant: "Coop · Test kauplus",
      number: "COOP-APP-1",
      purchasedAt: "2026-10-03",
      total: 257,
      cardAmount: 257,
    });
    expect(receipt.items.map((item) => item.amount)).toEqual([
      36, 129, 10, 72, 10,
    ]);
    expect(receipt.items[0]).toMatchObject({
      description: "VIRSIK KG",
      quantity: "0.18",
    });
    expect(receipt.items[2].categoryId).toBe("deposits");
    expect(receipt.items[4].categoryId).toBe("deposits");
  });
  it("accepts one-decimal totals without treating summary savings as another discount", () => {
    const receipt = parseReceipt(`Test Konsum
Coop äpp
Ost nr: COOP-APP-2
Kuupäev: 03.10.2026 11:58
Nimetus Kogus Summa
PIIM 1 2.9
4740000000001
KOKKU 2.9 €
Kaart 2.9
SK soodustus 1.5 €`);
    expect(receipt).toMatchObject({ valid: true, total: 290, cardAmount: 290 });
    expect(receipt.items).toHaveLength(1);
    expect(
      parseReceipt(receipt.text.replace("Kaart 2.9", "Kaart 2.8")).valid,
    ).toBe(false);
  });
  it("separates the header total, basket, quantities, payments and VAT", () => {
    const receipt = parseReceipt(coopReceiptText);
    expect(receipt).toMatchObject({
      retailer: "coop",
      number: "COOP-TEST-1001",
      purchasedAt: "2026-10-03",
      total: 567,
      cardAmount: 567,
      valid: true,
    });
    expect(receipt.items.map((item) => item.amount)).toEqual([
      279, 149, 10, 119, 10,
    ]);
    expect(
      receipt.items.every(
        (item) => item.quantity === "1" && item.unit === null,
      ),
    ).toBe(true);
    expect(receipt.items[0].description).toBe("AVOKAADO 2TK");
    expect(receipt.items.map((item) => item.categoryId)).toEqual([
      "groceries",
      "groceries",
      "deposits",
      "groceries",
      "deposits",
    ]);
  });
  it("preserves wrapped names and fractional quantities", () => {
    const receipt = parseReceipt(
      coopReceiptText.replace(
        "AVOKAADO 2TK 1 2.79",
        "AVOKAADO\n2TK 0,500 2.79",
      ),
    );
    expect(receipt.valid).toBe(true);
    expect(receipt.items[0]).toMatchObject({
      description: "AVOKAADO 2TK",
      quantity: "0.500",
      amount: 279,
    });
  });
  it("supports split cash/card tender without counting footer rows", () => {
    const receipt = parseReceipt(
      coopReceiptText.replace(
        "Kaart 5.67 EUR",
        "Kaart 3.00 EUR\nSularaha 2.67 EUR",
      ),
    );
    expect(receipt).toMatchObject({
      valid: true,
      cardAmount: 300,
      cashAmount: 267,
      total: 567,
    });
  });
  it.each([
    ["Summa 5.67", "Summa 5.68"],
    ["Kokku 5.67", "Kokku 5.68"],
    ["Kaart 5.67", "Kaart 5.68"],
    ["1 2.79", "1 unreadable"],
    ["03/10/2026", "31/02/2026"],
    ["Tsekk nr COOP-TEST-1001", "Missing identity"],
  ])("requires reconciliation and valid identity: %s", (before, after) => {
    expect(parseReceipt(coopReceiptText.replace(before, after)).valid).toBe(
      false,
    );
  });
});
