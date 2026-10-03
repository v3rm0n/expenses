import { describe, expect, it } from "vitest";
import { parseReceipt } from "../../src/lib/receipt-parser";
import { woltEmailOrder } from "../../src/lib/wolt-receipt";
import { woltOrderId, woltReceiptText, lidlReceiptText } from "../fixtures";

describe("Wolt documents", () => {
  it("parses food prices and discounts without counting preview prices or VAT", () => {
    const receipt = parseReceipt(woltReceiptText());
    expect(receipt).toMatchObject({
      retailer: "wolt",
      orderId: woltOrderId,
      total: 600,
      cardAmount: 600,
      valid: true,
      purchasedAt: "2026-10-02",
    });
    expect(receipt.items.map((item) => item.amount)).toEqual([500, -100, 200]);
    expect(receipt.items[0].description).toBe("Burger with fries");
    expect(
      receipt.items.every((item) => item.categoryId === "restaurants"),
    ).toBe(true);
  });
  it("parses courier tips and service fee discounts separately", () => {
    const receipt = parseReceipt(woltReceiptText(true));
    expect(receipt).toMatchObject({
      valid: true,
      total: 140,
      cardAmount: 140,
      orderId: woltOrderId,
    });
    expect(receipt.items.map((item) => item.amount)).toEqual([0, 50, 100, -10]);
  });
  it("reads the email order total despite bidirectional formatting characters", () => {
    expect(
      woltEmailOrder(
        `Forwarded from Wolt\nOrder ID: ${woltOrderId}\nTotal EUR \u200e7.40\n7.40`,
      ),
    ).toEqual({ orderId: woltOrderId, total: 740, currency: "EUR" });
    expect(
      woltEmailOrder(`Order ID: ${woltOrderId}\nTotal EUR 7.40`),
    ).toBeNull();
  });
  it.each([
    ["02.10.2026", "31.02.2026"],
    ["2.00 2.00", "2.00 2.01"],
    ["Apple Pay 6.00", "Apple Pay 6.01"],
    [`Order ID ${woltOrderId}`, "Order ID missing"],
  ])(
    "requires valid identities, dates and reconciled amounts: %s",
    (before, after) => {
      expect(parseReceipt(woltReceiptText().replace(before, after)).valid).toBe(
        false,
      );
    },
  );
});

describe("Lidl image layout", () => {
  it("handles OCR that collapses the banana discount separator", () => {
    expect(
      parseReceipt(lidlReceiptText.replace("- -0,29", "--0,29")).valid,
    ).toBe(true);
  });
  it("keeps product codes, unit prices, quantities and discounts in their proper roles", () => {
    const receipt = parseReceipt(lidlReceiptText);
    expect(receipt).toMatchObject({
      valid: true,
      number: "TEST-LIDL-1001",
      total: 293,
      cardAmount: 293,
      purchasedAt: "2026-10-02",
    });
    expect(receipt.items.map((item) => item.amount)).toEqual([
      29, 89, -24, 93, -29, 135,
    ]);
    expect(receipt.items[0].categoryId).toBe("household");
    expect(receipt.items[3]).toMatchObject({ quantity: "0.810", unit: "kg" });
    expect(receipt.items[5]).toMatchObject({ quantity: "1", unit: "tk" });
  });
  it.each([
    ["Tasuda 2,93", "Tasuda 2,95"],
    ["Makstud (pangakaart) 2,93", "Makstud (pangakaart) 2,95"],
    ["Vahesumma 3,46", "Vahesumma 3,45"],
    ["Allahindlus kokku -0,53", "Allahindlus kokku -0,52"],
    ["02.10.2026", "31.02.2026"],
    ["1,35 A", "unreadable A"],
  ])(
    "sends missing prices and conflicting totals to review: %s",
    (before, after) => {
      expect(parseReceipt(lidlReceiptText.replace(before, after)).valid).toBe(
        false,
      );
    },
  );
});
