import { describe, expect, it } from "vitest";
import { parseReceipt } from "../../src/lib/receipt-parser";
import { selverPdfText } from "../fixtures";

describe("Selver / Partnerkaart PDF", () => {
  it("reconciles discounted rows and bonus money while keeping deposits and repeated products", () => {
    const receipt = parseReceipt(selverPdfText);
    expect(receipt).toMatchObject({
      retailer: "partnerkaart",
      merchant: "Selver",
      number: "PDF-1001",
      purchasedAt: "2026-09-28",
      total: 936,
      cardAmount: 936,
      cashAmount: null,
      valid: true,
      issues: [],
      text: selverPdfText,
    });
    expect(receipt.items).toHaveLength(7);
    expect(receipt.items[1].quantity).toBe("0.228");
    expect(receipt.items[2].description).toBe(receipt.items[3].description);
    expect(
      receipt.items.slice(-2).map((item) => [item.amount, item.categoryId]),
    ).toEqual([
      [10, "deposits"],
      [10, "deposits"],
    ]);
    expect(receipt.items.reduce((sum, item) => sum + item.amount, 0)).toBe(936);
    expect(
      receipt.items.some((item) => /võit|Kokku|Makse/.test(item.description)),
    ).toBe(false);
  });
  it("supports cash, mixed tender, wrapped names and non-discounted purchases", () => {
    const receipt = parseReceipt(
      selverPdfText
        .replace(
          "Boonusmakse 0,47 EUR\nPartnerÄpp makse 9,36 EUR",
          "Pangakaart 5,00 EUR\nSularaha 4,83 EUR",
        )
        .replace("Avokaado. 0,228", "Mahe\nAvokaado. 0,228"),
    );
    expect(receipt).toMatchObject({
      valid: true,
      total: 983,
      cardAmount: 500,
      cashAmount: 483,
    });
    expect(receipt.items[1].description).toBe("Mahe Avokaado.");
    expect(receipt.items[4].amount).toBe(375);
  });
  it.each([
    ["Kokku 9,83 EUR", "Kokku 9,84 EUR"],
    ["PartnerÄpp makse 9,36 EUR", "PartnerÄpp makse 9,35 EUR"],
    ["Boonusmakse 0,47 EUR", "Boonusmakse unknown EUR"],
    ["Boonusmakse 0,47 EUR", "Boonusmakse"],
    ["Kokku 9,83 EUR", "Kokku unknown EUR"],
    ["Boonusmakse 0,47 EUR", "Boonusmakse -0,47 EUR"],
    ["28.09.2026", "31.09.2026"],
    ["Tšeki nr PDF-1001", "Missing identity"],
    ["Avokaado. 0,228 6,97 1,59 EUR", "Avokaado. unknown 6,97 1,59 EUR"],
    ["PartnerÄpp makse 9,36 EUR", ""],
  ])("keeps damaged receipts in review: %s", (before, after) => {
    const receipt = parseReceipt(selverPdfText.replace(before, after));
    expect(receipt.valid).toBe(false);
    expect(receipt.total).not.toBe(936);
  });
  it("does not intercept other retailer PDF layouts", () => {
    expect(
      parseReceipt(
        selverPdfText
          .replaceAll("Selver", "Coop")
          .replace("Partnerkaart TEST", "Coop TEST"),
      ).retailer,
    ).toBe("coop");
  });
});
