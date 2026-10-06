import { expect, it } from "vitest";
import {
  analysisBreakdown,
  cumulativeCashFlow,
  type SpendingAnalysis,
} from "../../src/lib/spending-analysis";

it("accumulates net cash flow including refunds, contributions and withdrawals and resets for each period", () => {
  const months = [
    {
      month: "2026-01",
      income: 10000,
      spending: 15000,
      investment: 2000,
      pension: 500,
    },
    {
      month: "2026-02",
      income: 10000,
      spending: -1000,
      investment: -2000,
      pension: 500,
    },
    { month: "2026-03", income: 0, spending: 0, investment: 0, pension: 0 },
  ];
  expect(
    cumulativeCashFlow(months).map((point) => point.cumulativeNetCashFlow),
  ).toEqual([-7500, 5000, 5000]);
  expect(
    cumulativeCashFlow(months.slice(1)).map(
      (point) => point.cumulativeNetCashFlow,
    ),
  ).toEqual([12500, 12500]);
});

it("keeps split purchases and refunds in the correct month, category and merchant", () => {
  const data: SpendingAnalysis = {
    month: "2026-10",
    currency: "EUR",
    from: "2026-05-01",
    to: "2026-11-01",
    investment: {
      contributed: 0,
      withdrawn: 0,
      net: 0,
      history_contributed: 0,
      history_withdrawn: 0,
      history_net: 0,
    },
    pension: {
      contributed: 0,
      withdrawn: 0,
      net: 0,
      history_contributed: 0,
      history_withdrawn: 0,
      history_net: 0,
    },
    months: [
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
    ].map((month) => ({
      month,
      spending: 0,
      income: 0,
      investment: 0,
      pension: 0,
    })),
    categories: [
      {
        month: "2026-05",
        id: "groceries",
        name: "Groceries",
        color: "green",
        amount: 600,
      },
      {
        month: "2026-05",
        id: "gifts",
        name: "Gifts",
        color: "blue",
        amount: 400,
      },
      {
        month: "2026-06",
        id: "groceries",
        name: "Groceries",
        color: "green",
        amount: -200,
      },
      {
        month: "2026-10",
        id: "gifts",
        name: "Gifts",
        color: "blue",
        amount: -900,
      },
    ],
    merchants: [
      {
        month: "2026-05",
        category_id: "groceries",
        merchant: "Market",
        amount: 600,
      },
      {
        month: "2026-05",
        category_id: "gifts",
        merchant: "Market",
        amount: 400,
      },
      {
        month: "2026-06",
        category_id: "groceries",
        merchant: "Market",
        amount: -200,
      },
      {
        month: "2026-10",
        category_id: "gifts",
        merchant: "Shop",
        amount: -900,
      },
    ],
  };
  const all = analysisBreakdown(data);
  expect(all.categories.map((row) => [row.id, row.amount])).toEqual([
    ["groceries", 400],
    ["gifts", -500],
  ]);
  expect(all.merchants).toEqual([
    { merchant: "Market", amount: 800 },
    { merchant: "Shop", amount: -900 },
  ]);
  const filtered = analysisBreakdown(data, "2026-05", "groceries");
  expect(filtered.categories.reduce((sum, row) => sum + row.amount, 0)).toBe(
    1000,
  );
  expect(filtered.merchants).toEqual([{ merchant: "Market", amount: 600 }]);
  expect(filtered.categoryTrend.map((row) => row.amount)).toEqual([
    600, -200, 0, 0, 0, 0,
  ]);
  expect(analysisBreakdown(data, "2026-07").merchants).toEqual([]);
});
