import { describe, expect, it } from "vitest";
import { parseReceipt } from "../../src/lib/receipt-parser";
import { coopReceiptText } from "../fixtures";

describe("Coop digital receipts", () => {
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
