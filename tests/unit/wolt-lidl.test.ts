import { describe, expect, it } from "vitest";
import { parseReceipt } from "../../src/lib/receipt-parser";
import { woltEmailOrder } from "../../src/lib/wolt-receipt";
import { woltOrderId, woltReceiptText, lidlReceiptText } from "../fixtures";

describe("Wolt documents", () => {
  it("subtracts an explicit payment discount from spend while keeping table discounts once", () => {
    const text = woltReceiptText().replace(
      "Apple Pay 6.00",
      "Apple Pay 5.00\nDiscount 1.00",
    );
    const receipt = parseReceipt(text);
    expect(receipt).toMatchObject({ valid: true, total: 500, cardAmount: 500 });
    expect(receipt.items.map((item) => item.amount)).toEqual([
      500, -100, 200, -100,
    ]);
    expect(receipt.items.at(-1)?.categoryId).toBe("restaurants");
    expect(
      parseReceipt(text.replace("Discount 1.00", "Discount 0.99")).valid,
    ).toBe(false);
    expect(
      parseReceipt(text.replace("Discount 1.00", "Discount unreadable")).valid,
    ).toBe(false);
    expect(parseReceipt(text.replace("2.00 2.00", "2.00 2.01")).valid).toBe(
      false,
    );
  });
  it("reads weighed groceries, preserves wrapped package sizes, and excludes deposits from voucher allocations", () => {
    const text = woltReceiptText()
      .replace("Venue Test Burger Kitchen", "Venue Wolt Market Test")
      .replace("Apple Pay 6.00", "Apple Pay 6.00\nDiscount 1.20")
      .replace(
        /Item VAT %[\s\S]*?Total in EUR \(incl\. VAT\) 6.00/,
        `Item VAT % Quantity Gross unit price Price
Chicken breast,
24% 1 5.00 5.00
400g
Ramen Cheese
24% 1 1.00 1.00
140g
Deposit 0% 2 0.10 0.20
Courgette 24% 350 g 1.99/kg 0.70
Sweet potato 24% 0.100 kg 3.00/kg 0.30
Total in EUR (incl. VAT) 7.20`,
      );
    const receipt = parseReceipt(text);
    expect(receipt).toMatchObject({ valid: true, total: 600, cardAmount: 600 });
    expect(receipt.items.slice(0, 5).map((item) => item.description)).toEqual([
      "Chicken breast, 400g",
      "Ramen Cheese 140g",
      "Deposit",
      "Courgette",
      "Sweet potato",
    ]);
    expect(receipt.items[3]).toMatchObject({
      quantity: "350",
      unit: "g",
      amount: 70,
    });
    expect(receipt.items[4]).toMatchObject({
      quantity: "0.100",
      unit: "kg",
      amount: 30,
    });
    expect(
      receipt.items
        .filter((item) => item.categoryId === "deposits")
        .map((item) => item.amount),
    ).toEqual([20]);
    expect(receipt.items.reduce((sum, item) => sum + item.amount, 0)).toBe(600);
  });
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
  it("includes Lidl Plus discounts once and still validates the discount summary", () => {
    const text = lidlReceiptText.replace(
      "Allahindlus: -0,24",
      "Lidl Plus allahindlus -0,24",
    );
    const receipt = parseReceipt(text);
    expect(receipt).toMatchObject({ valid: true, total: 293 });
    expect(receipt.items[2]).toMatchObject({
      amount: -24,
      categoryId: receipt.items[1].categoryId,
    });
    expect(
      parseReceipt(
        text.replace(
          "Lidl Plus allahindlus -0,24",
          "Lidl Plus allahindlus -0,23",
        ),
      ).valid,
    ).toBe(false);
  });
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
