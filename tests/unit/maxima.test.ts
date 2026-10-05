import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseReceipt } from "../../src/lib/receipt-parser";

const text = readFileSync(
  new URL("../fixtures/maxima.txt", import.meta.url),
  "utf8",
);

describe("Maxima digital receipts", () => {
  it("reads quantities, wrapped names, deposits and a discount repeated in the footer", () => {
    const receipt = parseReceipt(text);
    expect(receipt).toMatchObject({
      retailer: "maxima",
      merchant: "Maxima",
      number: "MAXIMA-TEST-1001",
      purchasedAt: "2026-07-30",
      currency: "EUR",
      total: 1195,
      cardAmount: 1195,
      cashAmount: null,
      valid: true,
      issues: [],
      text,
    });
    expect(receipt.items.map((item) => item.amount)).toEqual([
      75, 10, 75, 10, 38, 229, 569, 315, -126,
    ]);
    expect(receipt.items[4]).toMatchObject({
      quantity: "2",
      unit: "tk",
      amount: 38,
    });
    expect(receipt.items[5].description).toBe(
      "Kummikommid Tutti-Frutti FAZER 180g",
    );
    expect(receipt.items[7].description).toBe(
      "Niisked salvr. HUGGIES Natural Care 48tk",
    );
    expect(receipt.items[8].categoryId).toBe(receipt.items[7].categoryId);
    expect(
      receipt.items
        .filter((item) => item.categoryId === "deposits")
        .map((item) => item.amount),
    ).toEqual([10, 10]);
  });
  it("supports fractional quantities, four-digit years and split tender", () => {
    const receipt = parseReceipt(
      text
        .replace("30.07.26", "30.07.2026")
        .replace("1 tk 0,75", "0,500 kg 1,50")
        .replace(
          "Maksevahend Pangakaardiga 555555******1111 11,95 €",
          "Maksevahend Pangakaardiga 555555******1111 5,00 €\nMaksevahend Sularahas 6,95 €",
        ),
    );
    expect(receipt).toMatchObject({
      valid: true,
      cardAmount: 500,
      cashAmount: 695,
    });
    expect(receipt.items[0]).toMatchObject({ quantity: "0.500", unit: "kg" });
  });
  it("supports a cash purchase without discounts", () => {
    const receipt = parseReceipt(
      text
        .replace("Soodustus -1,26 €\n", "")
        .replace(/Allahindlus kokku:[\s\S]*?Kassiir:/, "Kassiir:")
        .replaceAll("11,95", "13,21")
        .replace("Pangakaardiga 555555******1111", "Sularahas"),
    );
    expect(receipt).toMatchObject({
      valid: true,
      total: 1321,
      cardAmount: null,
      cashAmount: 1321,
    });
    expect(receipt.items).toHaveLength(8);
  });
  it.each([
    ["Kokku 11,95", "Kokku 11,96"],
    ["Makstud 11,95", "Makstud 11,94"],
    ["1111 11,95", "1111 11,94"],
    ["Soodustus -1,26", "Soodustus unreadable"],
    ["Allahindlus kokku: -1,26", "Allahindlus kokku: -1,25"],
    ["1 tk 5,69", "1 tk unreadable"],
    ["30.07.26", "31.02.26"],
    ["Nr. MAXIMA-TEST-1001", "Missing identity"],
    ["Kokku 11,95 €", ""],
    ["Maksevahend Pangakaardiga 555555******1111 11,95 €", ""],
  ])("keeps damaged receipts in review: %s", (before, after) => {
    expect(parseReceipt(text.replace(before, after)).valid).toBe(false);
  });
  it("accepts an explicit source hint and leaves unrelated retailers alone", () => {
    expect(
      parseReceipt(text.replaceAll(/maxima/gi, "Store"), "maxima").valid,
    ).toBe(true);
    expect(
      parseReceipt("Rimi\n30.07.2026\nPiim 1,00\nKokku 1,00").retailer,
    ).toBe("rimi");
  });
});
