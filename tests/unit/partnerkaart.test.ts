import { describe, expect, it } from "vitest";
import { parseReceipt } from "../../src/lib/receipt-parser";
import { selverCsv } from "../fixtures";

describe("Partnerkaart / Selver CSV", () => {
  it("reconciles a BOM export and reads the receipt identity from the footer", () => {
    const receipt = parseReceipt(selverCsv);
    expect(receipt).toMatchObject({
      retailer: "partnerkaart",
      merchant: "Selver",
      number: "CSV-1001",
      purchasedAt: "2026-09-28",
      currency: "EUR",
      total: 963,
      cardAmount: 963,
      cashAmount: null,
      valid: true,
      issues: [],
    });
    expect(receipt.items.map((item) => item.amount)).toEqual([
      39, 159, 195, 195, 375,
    ]);
    expect(receipt.items.map((item) => item.categoryId)).toEqual([
      "household",
      "groceries",
      "children",
      "children",
      "personal_care",
    ]);
    expect(receipt.items[1]).toMatchObject({ quantity: "0.228", unit: null });
    expect(receipt.items[2].description).toBe(receipt.items[3].description);
  });
  it("ignores VAT totals rather than treating them as a basket or payment", () => {
    const receipt = parseReceipt(
      selverCsv.replace("KOKKU;7,77;1,86;9,63", "KOKKU;80,65;19,35;100,00"),
    );
    expect(receipt.valid).toBe(true);
    expect(receipt.total).toBe(963);
    expect(receipt.items).toHaveLength(5);
    expect(parseReceipt(selverCsv.replace("KOKKU;9,63", "")).total).toBeNull();
  });
  it("handles quoted delimiters, escaped quotes, multiline names and CRLF", () => {
    const input = selverCsv
      .replaceAll("Mahe raudne tatrap", '"Puder; ""kaer""\nmahe"')
      .replaceAll("\n", "\r\n");
    const receipt = parseReceipt(input);
    expect(receipt.valid).toBe(true);
    expect(receipt.items[2].description).toBe('Puder; "kaer"\nmahe');
    expect(receipt.items[2].categoryId).toBe("groceries");
  });
  it("accepts comma fractional quantities and split card/cash tender", () => {
    const receipt = parseReceipt(
      selverCsv
        .replace("0.228", "0,228")
        .replace("PARTNERAPP;9,63", "PARTNERAPP;5,00\nSULARAHA;4,63"),
    );
    expect(receipt).toMatchObject({
      valid: true,
      cardAmount: 500,
      cashAmount: 463,
    });
    expect(receipt.items[1].quantity).toBe("0.228");
  });
  it("deducts redeemed bonus money with exact cents and keeps the original text", () => {
    const input = selverCsv.replace(
      "PARTNERAPP;9,63",
      "BOONUSRAHA;0,47\nPARTNERAPP;9,16",
    );
    const receipt = parseReceipt(input);
    expect(receipt).toMatchObject({
      valid: true,
      total: 916,
      cardAmount: 916,
      issues: [],
    });
    expect(receipt.items.map((item) => item.amount)).toEqual([
      37, 151, 185, 186, 357,
    ]);
    expect(receipt.items[1].quantity).toBe("0.228");
    expect(receipt.text).toContain("BOONUSRAHA;0,47");
    expect(parseReceipt(input)).toEqual(receipt);
  });
  it("preserves deposits when splitting bonus money over products", () => {
    const receipt = parseReceipt(
      selverCsv
        .replace("KOKKU;9,63", "Pant;999055;1;0,10;0,10\nKOKKU;9,73")
        .replace(
          "PARTNERAPP;9,63",
          "BOONUSRAHA;0,47\nPARTNERAPP;5,00\nSULARAHA;4,26",
        ),
    );
    expect(receipt).toMatchObject({
      valid: true,
      total: 926,
      cardAmount: 500,
      cashAmount: 426,
    });
    expect(receipt.items.at(-1)).toMatchObject({
      categoryId: "deposits",
      amount: 10,
    });
    expect(receipt.items.reduce((sum, item) => sum + item.amount, 0)).toBe(926);
  });
  it("supports purchases paid entirely with bonus money", () => {
    const receipt = parseReceipt(
      selverCsv.replace("PARTNERAPP;9,63", "BOONUSRAHA;9,63"),
    );
    expect(receipt).toMatchObject({
      valid: true,
      total: 0,
      cardAmount: null,
      cashAmount: null,
    });
    expect(receipt.items.every((item) => item.amount === 0)).toBe(true);
  });
  it.each([
    ["BOONUSRAHA;unknown\nPARTNERAPP;9,16", "KOKKU;9,63"],
    ["BOONUSRAHA;-0,47\nPARTNERAPP;10,10", "KOKKU;9,63"],
    ["BOONUSRAHA;0,47\nPARTNERAPP;9,17", "KOKKU;9,63"],
    ["BOONUSRAHA;10,00\nPARTNERAPP;-0,37", "KOKKU;9,63"],
    ["BOONUSRAHA;0,47\nPARTNERAPP;9,16", "KOKKU;9,64"],
    ["BOONUSRAHA;0,47", "KOKKU;9,63"],
  ])(
    "keeps corrupt bonus tenders or baskets in review: %s",
    (tenders, total) => {
      const receipt = parseReceipt(
        selverCsv
          .replace("PARTNERAPP;9,63", tenders)
          .replace("KOKKU;9,63", total),
      );
      expect(receipt.valid).toBe(false);
      expect(receipt.items.map((item) => item.amount)).toEqual([
        39, 159, 195, 195, 375,
      ]);
    },
  );
  it.each([
    ["KOKKU;9,63", "KOKKU;9,64"],
    ["PARTNERAPP;9,63", "PARTNERAPP;9,64"],
    ["28.09.2026", "31.09.2026"],
    [";0.228;", ";unknown;"],
    [";1,59\n", ";1,5x\n"],
    ["TŠEKK;KUUPÄEV;AEG;KASSA", "MISSING METADATA"],
    [";KOGUS;", ";MISSING;"],
    ["Avokaado.", '"Avokaado.'],
  ])("routes corrupt data to review: %s", (before, after) => {
    const receipt = parseReceipt(selverCsv.replace(before, after));
    expect(receipt.valid).toBe(false);
    expect(receipt.issues.length).toBeGreaterThan(0);
  });
});
