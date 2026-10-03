import { describe, expect, it } from "vitest";
import { parseReceipt } from "../../src/lib/receipt-parser";

// Synthetic basket using the scanned Rimi export's layout and OCR artifacts.
const digitalReceipt = `Rimi
Digitaalne tšekk
KLIENT: TEST
Hambahari lastele Jordan
extra soft 2,29 A
Allah. -0,92 Uus hind 1,37
Juust Mozzarella Rimi 45% 125g
2,000 tk. X 1,39 2,78 A
Sibul, 50/70 mm, kg
0,196kg X 0,39EUR/Kg 0,08 A
Õlu Kosmos Põhjala 5,5% 0,44l 3,59 A
Metallist ühekorrapakend 0,10 E
Tampoonid Pro Comfort
norm. 16tk 4,49 A
Allah. -1,7%9 Uus hind 2,70
SINU SOODUSTUSED:
Ilutooted -2,71
Oled säästnud 2,71
KAARDIMAKSE
VIIPEMAKSE KVIITUNG 9999
MASTERCARD
SUMMA : 10,62 EUR
Teenitud Sinu RIMI raha 0,10
Sinu RIMI raha saldo 1,00
Soodustus Sinu RIMI kaardiga 2,71
KOKKU 10,62 EUR
KAARDIMAKSE 10,62 EUR
KM % KM-ga KM-ta KM
A 24,00% 10,52 8,48 2,04
E 0,00% 0,10 0,10 0,00
KASSA: 0001 ARVE NR: TEST-1001
KUUPÄEV: 02.10.2026 AEG: 12:00:00`;

describe("Rimi digital receipts", () => {
  it("joins wrapped names, reads quantities and reconciles net product prices", () => {
    const parsed = parseReceipt(digitalReceipt);
    expect(parsed).toMatchObject({
      valid: true,
      retailer: "rimi",
      number: "TEST-1001",
      purchasedAt: "2026-10-02",
      currency: "EUR",
      total: 1062,
      cardAmount: 1062,
      cashAmount: null,
      issues: [],
    });
    expect(parsed.items.map((item) => item.amount)).toEqual([
      137, 278, 8, 359, 10, 270,
    ]);
    expect(parsed.items.map((item) => item.categoryId)).toEqual([
      "household",
      "groceries",
      "groceries",
      "alcohol",
      "deposits",
      "household",
    ]);
    expect(parsed.items[0].description).toBe(
      "Hambahari lastele Jordan extra soft",
    );
    expect(parsed.items[1]).toMatchObject({ quantity: "2.000", unit: "tk" });
    expect(parsed.items[2]).toMatchObject({
      quantity: "0.196",
      unit: "kg",
      amount: 8,
    });
    expect(parsed.items.reduce((sum, item) => sum + item.amount, 0)).toBe(
      parsed.total,
    );
  });
  it("requires the basket to reconcile even when a discount has damaged OCR", () => {
    const parsed = parseReceipt(
      digitalReceipt.replace("Uus hind 2,70", "Uus hind 2,71"),
    );
    expect(parsed.valid).toBe(false);
    expect(parsed.issues.join(" ")).toMatch(/reconcile with the receipt total/);
  });
  it("flags inconsistent discounts even when the adjusted total reconciles", () => {
    const parsed = parseReceipt(
      digitalReceipt.replace("Allah. -0,92", "Allah. -0,91"),
    );
    expect(parsed.valid).toBe(false);
    expect(parsed.issues.join(" ")).toMatch(/discount does not reconcile/);
  });
  it("routes missing product prices and unreadable discounts to review", () => {
    expect(
      parseReceipt(digitalReceipt.replace("Uus hind 1,37", "Uus hind ???"))
        .valid,
    ).toBe(false);
    expect(
      parseReceipt(
        digitalReceipt.replace(
          "norm. 16tk 4,49 A\nAllah. -1,7%9 Uus hind 2,70",
          "norm. 16tk",
        ),
      ).valid,
    ).toBe(false);
  });
  it("reads spaced decimal totals and recognizes a damaged digital header without discounts", () => {
    const parsed = parseReceipt(`Rimi
Digitaalne tiekk
KLIENT: TEST
Piim 2,00 A
KAARDIMAKSE
KOKKU 2, 00 EUR
KAARDIMAKSE 2,00 EUR
ARVE NR: SPACED
02.10.2026`);
    expect(parsed).toMatchObject({ valid: true, total: 200, issues: [] });
    expect(parsed.items.map((item) => item.description)).toEqual(["Piim"]);
  });
  it("keeps a wrapped decimal volume in the product name rather than making it another price", () => {
    const parsed = parseReceipt(
      digitalReceipt.replace(
        "Õlu Kosmos Põhjala 5,5% 0,44l 3,59 A",
        "Õlu Kosmos Põhjala 5,5% 0,51\npdl 3,59 A",
      ),
    );
    expect(parsed.valid).toBe(true);
    expect(parsed.items).toHaveLength(6);
    expect(parsed.items[3]).toMatchObject({
      amount: 359,
      description: "Õlu Kosmos Põhjala 5,5% 0,51 pdl",
    });
  });
  it("recognizes OCR variants of the new-price label", () => {
    expect(
      parseReceipt(digitalReceipt.replace("Uus hind 1,37", "Üus hind 1,37"))
        .valid,
    ).toBe(true);
    expect(
      parseReceipt(digitalReceipt.replace("Uus hind 1,37", "Tus hind 1,37"))
        .valid,
    ).toBe(true);
  });
  it("applies redeemed loyalty money once across products while preserving deposits", () => {
    const parsed = parseReceipt(
      digitalReceipt
        .replace(
          "SINU SOODUSTUSED:",
          "SINU SOODUSTUSED:\nKasutatud Sinu RIMI raha -1,00",
        )
        .replaceAll("10,62", "9,62"),
    );
    expect(parsed.valid).toBe(true);
    expect(parsed.items.reduce((sum, item) => sum + item.amount, 0)).toBe(962);
    expect(parsed.items[4].amount).toBe(10);
    expect(parsed.items.map((item) => item.categoryId)).toEqual(
      parseReceipt(digitalReceipt).items.map((item) => item.categoryId),
    );
  });
  it("repairs a single OCR digit in a counted product only when the complete basket reconciles", () => {
    const damaged = digitalReceipt.replace("X 1,39 2,78 A", "X 1,39 3,78 A");
    expect(parseReceipt(damaged)).toMatchObject({ valid: true, total: 1062 });
    expect(parseReceipt(damaged).items[1].amount).toBe(278);
    expect(parseReceipt(damaged.replaceAll("10,62", "10,63")).valid).toBe(
      false,
    );
    expect(
      parseReceipt(digitalReceipt.replace("X 1,39 2,78 A", "X 1,39 4,99 A"))
        .valid,
    ).toBe(false);
  });
  it("repairs a damaged total only when the terminal slip, card tender and basket all agree", () => {
    const damaged = digitalReceipt.replace("KOKKU 10,62", "KOKKU 50,62");
    expect(parseReceipt(damaged)).toMatchObject({ valid: true, total: 1062 });
    expect(
      parseReceipt(damaged.replace("SUMMA : 10,62 EUR", "SUMMA : 10,63 EUR"))
        .valid,
    ).toBe(false);
    expect(
      parseReceipt(damaged.replace("KAARDIMAKSE 10,62", "KAARDIMAKSE 10,63"))
        .valid,
    ).toBe(false);
    expect(parseReceipt(damaged.replace("SUMMA : 10,62 EUR", "")).valid).toBe(
      false,
    );
  });
});
