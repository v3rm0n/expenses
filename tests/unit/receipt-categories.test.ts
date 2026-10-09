import { describe, expect, it } from "vitest";
import { productCategory } from "../../src/lib/classification";
import { parseAmazonReceipt } from "../../src/lib/amazon-receipt";
import {
  parseWoltReceipt,
  recategorizeWoltDiscounts,
} from "../../src/lib/wolt-receipt";
import type { ReceiptItem } from "../../src/lib/types";
import { woltReceiptText } from "../fixtures";

describe("receipt categorization", () => {
  it("treats Stockmann purchases as groceries and flowers as gifts", () => {
    const stockmann = parseWoltReceipt(
      woltReceiptText().replace("Test Burger Kitchen", "Stockmann"),
    );
    expect(stockmann?.valid).toBe(true);
    expect(
      stockmann?.items.every((item) => item.categoryId === "groceries"),
    ).toBe(true);
    const flowers = parseWoltReceipt(
      woltReceiptText()
        .replace("Test Burger Kitchen", "Studio Nelk")
        .replace("Burger with fries", "Hooajaline lillekimp")
        .replace("Burger 24%", "Hooajaline lillekimp 24%")
        .replace("with fries", ""),
    );
    expect(flowers?.valid).toBe(true);
    expect(flowers?.items[0].categoryId).toBe("gifts");
  });
  it.each([
    ["Huggies Pants Extra Care 80 Windeln", "children"],
    ["Püksmähkmed Pants", "children"],
    ["Pant C/0.10EUR", "deposits"],
    ["Beebispinat 100g", "groceries"],
    ["Alkoholivaba õlu Saku Rock Zero", "groceries"],
    ["SUN CITY PINEAPPLE 0.44L", "alcohol"],
    ["Toidulisand Kaltsium", "health"],
    ["H/PASTA ECODENTA 100ML", "personal_care"],
    ["Hambapasta lastele", "children"],
    ["Ultra Compact antibakteriaalsed üldpuhastuslapid", "household"],
    ["Grite paberkäterätt Blossom", "household"],
    ["SAN.SILIKOON FOME 310ML", "home_improvement"],
    ["Hooajaline lillekimp", "gifts"],
  ])(
    "classifies %s without broad substring collisions",
    (description, category) => {
      expect(productCategory(description)).toBe(category);
    },
  );
  it("reallocates vouchers after product overrides and keeps deposits out", () => {
    const item = (
      description: string,
      amount: number,
      categoryId: string,
    ): ReceiptItem => ({
      description,
      amount,
      categoryId,
      quantity: null,
      unit: null,
      manual: false,
    });
    const items = [
      item("Meal", 3000, "restaurants"),
      item("Jinro Soju 360ml", 1000, "alcohol"),
      item("Deposit", 100, "deposits"),
      item("Wolt payment discount · restaurants", -400, "restaurants"),
    ];
    const result = recategorizeWoltDiscounts(items);
    expect(result.slice(-2).map((i) => [i.categoryId, i.amount])).toEqual([
      ["restaurants", -300],
      ["alcohol", -100],
    ]);
    expect(result.reduce((n, i) => n + i.amount, 0)).toBe(3700);
  });
  it("moves an ordinary discount with its mapped product even without a voucher", () => {
    const items: ReceiptItem[] = [
      {
        description: "Baby puree",
        amount: 200,
        categoryId: "children",
        quantity: null,
        unit: null,
        manual: true,
      },
      {
        description: "Discount",
        amount: -20,
        categoryId: "groceries",
        quantity: null,
        unit: null,
        manual: false,
      },
    ];
    expect(recategorizeWoltDiscounts(items)[1].categoryId).toBe("children");
  });
  it("does not mix a wrapped Amazon product description into shipping", () => {
    const receipt = parseAmazonReceipt(
      `Invoice\nAmazon EU S.à r.l.\nInvoice date 02 October 2026\nInvoice number SYNTHETIC-1\nOrder number 111-2222222-3333333\nDescription Quantity Unit price VAT Gross price Total\nMemory card 1 10.00 EUR 24% 12.40 EUR 12.40 EUR\nwith SD adapter and a long warranty\nASIN: SYNTHETIC\nShipping 1.00 EUR 1.24 EUR 1.24 EUR\nDiscount -1.00 EUR -1.24 EUR -1.24 EUR\nInvoice total 12.40 EUR`,
    );
    expect(receipt?.valid).toBe(true);
    expect(
      receipt?.items.map((i) => [i.description, i.amount, i.categoryId]),
    ).toEqual([
      [
        "Memory card with SD adapter and a long warranty",
        1240,
        "uncategorized",
      ],
      ["Shipping", 124, "shipping"],
      ["Discount · Versandkosten", -124, "shipping"],
    ]);
  });
});
