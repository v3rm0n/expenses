import { describe, expect, it } from "vitest";
import {
  amountFormatter,
  formatRelativeAmount,
} from "../../src/lib/amount-display";
import { formatMoney } from "../../src/lib/money";

describe("relative amounts", () => {
  it("preserves negative refunds and amounts above the base", () => {
    expect(formatRelativeAmount(2500, 10000)).toBe("25%");
    expect(formatRelativeAmount(-2500, 10000)).toBe("-25%");
    expect(formatRelativeAmount(12500, 10000)).toBe("125%");
    expect(formatRelativeAmount(1, 3)).toBe("33.3%");
  });

  it("handles empty periods without exposing money or invalid percentages", () => {
    expect(formatRelativeAmount(0, 0)).toBe("0%");
    for (const base of [0, -100, NaN, Infinity]) {
      expect(formatRelativeAmount(100, base)).toBe("—");
    }
  });

  it("keeps absolute formatting and is independent of currency scale in percentage mode", () => {
    for (const currency of ["EUR", "JPY", "KWD"]) {
      expect(amountFormatter(currency, false, 1000)(250)).toBe(
        formatMoney(250, currency),
      );
      expect(amountFormatter(currency, true, 1000)(250)).toBe("25%");
    }
  });
});
