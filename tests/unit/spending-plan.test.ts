import { describe, expect, it } from "vitest";
import {
  emptyPlan,
  goalProgress,
  monthTiming,
  spendingOutlook,
  type PlanningInputs,
} from "../../src/lib/spending-plan";

const contributions = (net = 0) => ({
  net,
  contributed: Math.max(0, net),
  withdrawn: Math.max(0, -net),
  history_net: net,
  history_contributed: Math.max(0, net),
  history_withdrawn: Math.max(0, -net),
});
function input(overrides: Partial<PlanningInputs> = {}): PlanningInputs {
  return {
    month: "2026-10",
    today: "2026-10-10",
    plan: {
      ...emptyPlan(),
      income: 250000,
      investmentMonthly: 30000,
      pensionMonthly: 15000,
      buffer: 10000,
    },
    spending: 40000,
    income: 250000,
    investment: contributions(10000),
    pension: contributions(5000),
    yearInvestment: 10000,
    yearPension: 5000,
    pending: { spending: 0, investment: 0, pension: 0, outgoing: 0, count: 0 },
    categories: [
      { id: "groceries", name: "Groceries", color: "green", amount: 40000 },
    ],
    ...overrides,
  };
}

describe("spending outlook", () => {
  it("separates living surplus from contributions and reserves only the goal still needed", () => {
    const result = spendingOutlook(input());
    expect(result.surplus).toBe(210000);
    expect(result.afterContributions).toBe(195000);
    expect(result.investment.remaining).toBe(20000);
    expect(result.pension.remaining).toBe(10000);
    expect(result.spendingLimit).toBe(195000);
    expect(result.allowance).toBe(155000);
  });
  it("counts pending payments once, including contributions already on their way", () => {
    const result = spendingOutlook(
      input({
        pending: {
          spending: 2000,
          investment: 25000,
          pension: 5000,
          outgoing: 33000,
          count: 3,
        },
      }),
    );
    expect(result.investment.remaining).toBe(0);
    expect(result.pension.remaining).toBe(5000);
    expect(result.spendingLimit).toBe(190000);
    expect(result.allowance).toBe(148000);
    expect(result.forecastSpending).toBe(126000);
  });
  it("does not extrapolate paid bills, pending bills, or fixed categories twice", () => {
    const base = input();
    const result = spendingOutlook(
      input({
        spending: 100000,
        categories: [
          ...base.categories,
          { id: "housing", name: "Housing", color: "blue", amount: 60000 },
        ],
        pending: {
          spending: 3000,
          investment: 0,
          pension: 0,
          outgoing: 3000,
          count: 1,
        },
        plan: {
          ...base.plan,
          budgets: [{ categoryId: "housing", amount: 60000, flexible: false }],
          bills: [
            {
              id: "paid",
              name: "Rent",
              amount: 60000,
              dueDay: 1,
              status: "paid",
              categoryId: "housing",
            },
            {
              id: "pending",
              name: "Pending bill",
              amount: 3000,
              dueDay: 10,
              status: "pending",
              categoryId: null,
            },
            {
              id: "unpaid",
              name: "Electricity",
              amount: 2000,
              dueDay: 20,
              status: "unpaid",
              categoryId: "housing",
            },
          ],
        },
      }),
    );
    expect(result.forecastSpending).toBe(189000);
    expect(result.unpaidTotal).toBe(2000);
    expect(
      result.categories.find((row) => row.id === "housing")?.projected,
    ).toBe(62000);
  });
  it("checks cash before payday separately, without assuming future income has arrived", () => {
    const base = input();
    const result = spendingOutlook(
      input({
        pending: {
          spending: 2000,
          investment: 0,
          pension: 0,
          outgoing: 5000,
          count: 2,
        },
        plan: {
          ...base.plan,
          cashBalance: 20000,
          nextPayday: "2026-10-20",
          bills: [
            {
              id: "early",
              name: "Bill before payday",
              amount: 10000,
              dueDay: 15,
              status: "unpaid",
              categoryId: null,
            },
            {
              id: "late",
              name: "Later bill",
              amount: 30000,
              dueDay: 25,
              status: "unpaid",
              categoryId: null,
            },
          ],
        },
      }),
    );
    expect(result.cashBeforePayday).toBe(-5000);
    expect(result.billsBeforePayday.map((bill) => bill.id)).toEqual(["early"]);
    expect(result.allowance).toBe(113000);
  });
  it("honors a zero spending cap and reports deficits without a negative daily allowance", () => {
    const base = input();
    const result = spendingOutlook(
      input({ plan: { ...base.plan, spendingLimit: 0 } }),
    );
    expect(result.allowance).toBe(-40000);
    expect(result.dailyAllowance).toBe(0);
    expect(result.forecastOverrun).toBe(124000);
  });
  it("reserves all recorded bills when the previously entered payday has passed", () => {
    const base = input();
    const result = spendingOutlook(
      input({
        plan: {
          ...base.plan,
          cashBalance: 20000,
          nextPayday: "2026-10-01",
          bills: [
            {
              id: "later",
              name: "Bill",
              amount: 5000,
              dueDay: 15,
              status: "unpaid",
              categoryId: null,
            },
          ],
        },
      }),
    );
    expect(result.cashBeforePayday).toBe(5000);
    expect(result.billsBeforePayday).toHaveLength(1);
  });
  it("does not fabricate income or liquidity when inputs are missing", () => {
    const result = spendingOutlook(input({ plan: emptyPlan(), income: 0 }));
    expect(result.allowance).toBeNull();
    expect(result.forecastRemaining).toBeNull();
    expect(result.cashBeforePayday).toBeNull();
  });
  it("does not apply today's pending payments or pace to a completed month", () => {
    const result = spendingOutlook(
      input({
        month: "2026-09",
        pending: {
          spending: 10000,
          investment: 10000,
          pension: 10000,
          outgoing: 30000,
          count: 3,
        },
      }),
    );
    expect(result.status).toBe("past");
    expect(result.forecastSpending).toBe(40000);
    expect(result.dailyAllowance).toBeNull();
    expect(result.cashBeforePayday).toBeNull();
    expect(result.investment.remaining).toBe(20000);
  });
  it("uses received income for completed months rather than an unfulfilled income expectation", () => {
    const result = spendingOutlook(input({ month: "2026-09", income: 30000 }));
    expect(result.incomeBasis).toBe(30000);
    expect(result.allowance).toBe(-65000);
  });
  it("handles refunds and rounds month-end bill dates in leap years", () => {
    const base = input();
    const result = spendingOutlook(
      input({
        month: "2028-02",
        today: "2028-02-10",
        spending: -2000,
        plan: {
          ...base.plan,
          bills: [
            {
              id: "month-end",
              name: "Bill",
              amount: 10000,
              dueDay: 31,
              status: "unpaid",
              categoryId: null,
            },
          ],
        },
      }),
    );
    expect(result.forecastSpending).toBe(8000);
    expect(result.unpaidBills[0].date).toBe("2028-02-29");
    expect(monthTiming("2028-02", "2028-02-29").remainingDays).toBe(0);
  });
});

it("uses annual catch-up pace and reverses progress when contributions are returned", () => {
  const goal = goalProgress("2026-10", 10000, 120000, -5000, 85000);
  expect(goal.target).toBe(10000);
  expect(goal.remaining).toBe(15000);
  expect(goal.monthlyPercent).toBe(0);
  const behind = goalProgress("2026-12", 10000, 120000, 10000, 50000);
  expect(behind.target).toBe(80000);
  expect(behind.remaining).toBe(70000);
});
