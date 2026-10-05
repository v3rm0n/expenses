import { describe, expect, it } from "vitest";
import {
  parseMoney,
  decimalMoney,
  prorate,
  validDate,
} from "../../src/lib/money";
import { parseReceipt } from "../../src/lib/receipt-parser";
import {
  matchingRule,
  transactionKind,
  merchantCategory,
} from "../../src/lib/classification";
import { receiptText } from "../fixtures";
describe("exact money", () => {
  it.each([
    ["12.30", "EUR", 1230],
    ["1.234,56", "EUR", 123456],
    ["1 234,56", "EUR", 123456],
    ["−0,10", "EUR", -10],
    ["123", "JPY", 123],
    ["1.234", "KWD", 1234],
  ])("parses %s %s", (amount, currency, expected) =>
    expect(parseMoney(amount, currency)).toBe(expected),
  );
  it("rejects rounding and unsafe values", () => {
    expect(() => parseMoney("0.001")).toThrow();
    expect(() => parseMoney("999999999999999999")).toThrow();
    expect(() => parseMoney("12x")).toThrow();
  });
  it("round trips currency scales", () => {
    for (const currency of ["EUR", "USD", "JPY", "KWD"])
      for (const value of [-999, 0, 10001])
        expect(parseMoney(decimalMoney(value, currency), currency)).toBe(value);
  });
  it("allocates refunds and discounts without losing a cent", () => {
    expect(prorate([1, 1, 1], 100)).toEqual([34, 33, 33]);
    expect(prorate([200, 300, -50], -450)).toEqual([-200, -300, 50]);
    for (let value = -101; value <= 101; value++)
      expect(prorate([200, 333, -23], value).reduce((a, b) => a + b, 0)).toBe(
        value,
      );
  });
  it("rejects impossible dates", () => {
    expect(() => validDate("2026-02-31")).toThrow();
    expect(validDate("2024-02-29")).toBe("2024-02-29");
  });
});
describe("receipt reconciliation", () => {
  it.each(["Rimi", "Selver Partnerkaart", "Coop", "Lidl"])(
    "parses a synthetic %s receipt",
    (retailer) => {
      const receipt = parseReceipt(receiptText(retailer));
      expect(receipt.valid).toBe(true);
      expect(receipt.total).toBe(510);
      expect(receipt.items.map((item) => item.categoryId)).toEqual([
        "groceries",
        "household",
        "deposits",
      ]);
      expect(receipt.cardAmount).toBe(510);
    },
  );
  it("distributes basket discounts by product amounts", () => {
    const receipt = parseReceipt(
      "Rimi\n02.10.2026\nPiim 2,00\nPesuvahend 3,00\nKupong -1,00\nKokku 4,00",
    );
    expect(receipt.valid).toBe(true);
    expect(
      receipt.items
        .filter((item) => item.amount < 0)
        .map((item) => [item.categoryId, item.amount]),
    ).toEqual([
      ["groceries", -40],
      ["household", -60],
    ]);
  });
  it("routes mismatches and impossible dates to review", () => {
    expect(
      parseReceipt(receiptText().replace("Kokku 5,10", "Kokku 6,10")).valid,
    ).toBe(false);
    const invalid = parseReceipt(receiptText("Coop", "1", "31.02.2026"));
    expect(invalid.valid).toBe(false);
    expect(invalid.purchasedAt).toBeNull();
  });
  it("retains product discounts, quantities and refunds", () => {
    const receipt = parseReceipt(
      "Lidl\n02.10.2026\nMilk 4,00\n2 tk x 2,00\nDiscount -1,00\nTotal 3,00",
    );
    expect(receipt.valid).toBe(true);
    expect(receipt.items[0].quantity).toBe("2");
    expect(receipt.items[1].categoryId).toBe("groceries");
    expect(
      parseReceipt("Rimi\n02.10.2026\nPiim -2,00\nKokku -2,00").valid,
    ).toBe(true);
  });
});
describe("classification", () => {
  it.each(["Apple Pay", "Google Pay", "Card"])(
    "recognizes %s wallet funding without an own-account IBAN",
    (method) => {
      expect(
        transactionKind(
          "CRDT",
          `Bank transaction ${method} Top-Up by *3305`,
          false,
          "TOPUP",
        ),
      ).toBe("transfer");
    },
  );
  it("keeps ordinary incoming payments, refunds and purchases separate from card top-ups", () => {
    expect(
      transactionKind(
        "CRDT",
        "Reverb Payments Disbursement · Payment from Reverb B.v.",
        false,
        "TOPUP",
      ),
    ).toBe("income");
    expect(
      transactionKind("CRDT", "Salary · Payment from Employer", false, "TOPUP"),
    ).toBe("income");
    expect(
      transactionKind("CRDT", "Apple Pay Top-Up by *3305", false, "RCDT"),
    ).toBe("income");
    expect(transactionKind("CRDT", "Card refund", false, "CARD_REFUND")).toBe(
      "refund",
    );
    expect(
      transactionKind("DBIT", "Apple Pay Top-Up by *3305", false, "TOPUP"),
    ).toBe("expense");
    expect(
      transactionKind("CRDT", "Apple Pay Top-Up bonus", false, "TOPUP"),
    ).toBe("income");
  });
  it.each(["CRDT", "DBIT"] as const)(
    "keeps the %s side of currency conversion out of income and spending",
    (direction) => {
      expect(
        transactionKind(direction, "Exchanged to EUR", false, "EXCHANGE"),
      ).toBe("transfer");
    },
  );
  it("recognises outgoing contributions while keeping salaries and ordinary bank transfers separate", () => {
    expect(transactionKind("DBIT", "Lightyear EU Client Money", false)).toBe(
      "investment",
    );
    expect(transactionKind("DBIT", "Tuleva Fondid AS", false)).toBe(
      "investment",
    );
    expect(transactionKind("DBIT", "Tuleva pension fund", false)).toBe(
      "investment",
    );
    expect(transactionKind("CRDT", "Tuleva payment", false)).toBe("income");
    expect(transactionKind("DBIT", "AS PENSIONIKESKUS", false)).toBe("pension");
    expect(transactionKind("DBIT", "SEB III samba sissemakse", false)).toBe(
      "pension",
    );
    expect(transactionKind("DBIT", "My investment account", true)).toBe(
      "investment",
    );
    expect(
      transactionKind("CRDT", "Lightyear Financial Ltd Salary", false),
    ).toBe("income");
    expect(transactionKind("CRDT", "Pensionikeskus payment", false)).toBe(
      "income",
    );
    expect(transactionKind("DBIT", "LHV", false)).toBe("expense");
    expect(transactionKind("DBIT", "Revolut", true)).toBe("transfer");
  });
  it("separates income, refunds, ATM withdrawals and own transfers", () => {
    expect(transactionKind("CRDT", "salary", false)).toBe("income");
    expect(transactionKind("CRDT", "Rimi tagastus", false)).toBe("refund");
    expect(transactionKind("DBIT", "ATM withdrawal", false)).toBe(
      "cash_movement",
    );
    expect(transactionKind("DBIT", "Savings", true)).toBe("transfer");
  });
  it("respects explicit priority and normalization", () => {
    const rule = matchingRule(
      [
        {
          field: "merchant",
          pattern: "RIMI",
          category_id: "gifts",
          priority: 5,
          enabled: true,
        },
        {
          field: "merchant",
          pattern: "rimi",
          category_id: "groceries",
          priority: 100,
          enabled: true,
        },
      ],
      "Rimi Tallinn",
      "",
    );
    expect(rule?.category_id).toBe("gifts");
    expect(merchantCategory("Bolt Food")).toBe("restaurants");
  });
});
