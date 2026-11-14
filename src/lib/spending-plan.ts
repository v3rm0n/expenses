import type { Contributions, MonthlyTotals } from "./spending-analysis";
import { prorate } from "./money";

export type SpendingPlan = {
  income: number | null;
  spendingLimit: number | null;
  buffer: number;
  investmentMonthly: number;
  pensionMonthly: number;
  investmentAnnual: number;
  pensionAnnual: number;
  cashBalance: number | null;
  nextPayday: string | null;
  budgets: { categoryId: string; amount: number; flexible: boolean }[];
  bills: {
    id: string;
    name: string;
    amount: number;
    dueDay: number;
    status: "unpaid" | "pending" | "paid";
    categoryId: string | null;
  }[];
};

export const emptyPlan = (): SpendingPlan => ({
  income: null,
  spendingLimit: null,
  buffer: 0,
  investmentMonthly: 0,
  pensionMonthly: 0,
  investmentAnnual: 0,
  pensionAnnual: 0,
  cashBalance: null,
  nextPayday: null,
  budgets: [],
  bills: [],
});

export function monthTiming(month: string, today: string) {
  const [year, number] = month.split("-").map(Number);
  const days = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const status =
    month < today.slice(0, 7)
      ? "past"
      : month > today.slice(0, 7)
        ? "future"
        : "current";
  const elapsed =
    status === "past"
      ? days
      : status === "future"
        ? 0
        : Number(today.slice(8, 10));
  return { status, days, elapsed, remainingDays: days - elapsed };
}

export function goalProgress(
  month: string,
  monthly: number,
  annual: number,
  net: number,
  yearNet: number,
  pending = 0,
) {
  const monthsLeft = 13 - Number(month.slice(5, 7));
  const target = Math.max(
    monthly,
    annual > 0
      ? Math.max(0, Math.ceil((annual - (yearNet - net)) / monthsLeft))
      : 0,
  );
  return {
    target,
    net,
    yearNet,
    annual,
    pending,
    remaining: Math.max(0, target - net - pending),
    annualRemaining: Math.max(0, annual - yearNet),
    monthlyPercent:
      target > 0 ? Math.max(0, Math.min(100, (net / target) * 100)) : 0,
    annualPercent:
      annual > 0 ? Math.max(0, Math.min(100, (yearNet / annual) * 100)) : 0,
  };
}

// Unconfigured occasional categories are counted once, rather than assumed to
// recur daily. A saved flexible budget explicitly overrides these defaults.
export function projectsDailyPace(categoryId: string): boolean {
  return [
    "groceries",
    "restaurants",
    "transport",
    "household",
    "personal_care",
    "alcohol",
    "deposits",
  ].includes(categoryId);
}

export type PlanCategory = {
  id: string;
  name: string;
  color: string;
  amount: number;
  oneOffAmount?: number;
};
export type PlanningInputs = {
  month: string;
  today: string;
  plan: SpendingPlan;
  spending: number;
  income: number;
  investment: Contributions;
  pension: Contributions;
  yearInvestment: number;
  yearPension: number;
  pending: {
    spending: number;
    investment: number;
    pension: number;
    outgoing: number;
    count: number;
  };
  categories: PlanCategory[];
};

export function spendingOutlook(input: PlanningInputs) {
  const { plan, pending } = input;
  const timing = monthTiming(input.month, input.today);
  const activePending =
    timing.status === "current"
      ? pending
      : { spending: 0, investment: 0, pension: 0, outgoing: 0, count: 0 };
  const investment = goalProgress(
    input.month,
    plan.investmentMonthly,
    plan.investmentAnnual,
    input.investment.net,
    input.yearInvestment,
    activePending.investment,
  );
  const pension = goalProgress(
    input.month,
    plan.pensionMonthly,
    plan.pensionAnnual,
    input.pension.net,
    input.yearPension,
    activePending.pension,
  );
  const unpaidBills =
    timing.status === "past"
      ? []
      : plan.bills
          .filter((bill) => bill.status === "unpaid")
          .map((bill) => ({
            ...bill,
            date: `${input.month}-${String(Math.min(bill.dueDay, timing.days)).padStart(2, "0")}`,
          }))
          .sort((a, b) => a.date.localeCompare(b.date));
  const unpaidTotal = unpaidBills.reduce((sum, bill) => sum + bill.amount, 0);
  const paceCategories = input.categories.map((category) => {
    const budget = plan.budgets.find((row) => row.categoryId === category.id);
    const flexible = budget?.flexible ?? projectsDailyPace(category.id);
    const paid = plan.bills
      .filter(
        (bill) => bill.status === "paid" && bill.categoryId === category.id,
      )
      .reduce((sum, bill) => sum + bill.amount, 0);
    // Both are exclusions from repetition, not deductions from actual spending.
    // Use the larger exclusion where a one-off payment is also a paid bill.
    const oneOff = category.oneOffAmount ?? 0;
    const excluded = oneOff + Math.max(0, paid - Math.max(0, oneOff));
    return {
      ...category,
      flexible,
      budget: budget?.amount ?? null,
      pace: flexible ? Math.max(0, category.amount - excluded) : 0,
    };
  });
  const unassignedPaid = plan.bills
    .filter((bill) => bill.status === "paid" && !bill.categoryId)
    .reduce((sum, bill) => sum + bill.amount, 0);
  // A paid bill without a category is already in booked spending, but its
  // category is unknown. Remove it from total spending rather than from the
  // daily-pace categories, so rent booked in Housing cannot cancel groceries.
  const variableSpent = Math.max(
    0,
    Math.min(
      paceCategories.reduce((sum, row) => sum + row.pace, 0),
      input.spending - unassignedPaid,
    ),
  );
  const variableRemaining =
    timing.status === "current" && timing.elapsed > 0
      ? Math.round((variableSpent / timing.elapsed) * timing.remainingDays)
      : 0;
  const forecastSpending =
    input.spending + activePending.spending + unpaidTotal + variableRemaining;
  const incomeBasis =
    timing.status === "past"
      ? input.income
      : plan.income !== null
        ? Math.max(plan.income, input.income)
        : input.income > 0 || timing.status === "past"
          ? input.income
          : null;
  const reservedContributions =
    input.investment.net +
    activePending.investment +
    investment.remaining +
    input.pension.net +
    activePending.pension +
    pension.remaining;
  const affordableLimit =
    incomeBasis === null
      ? null
      : incomeBasis - reservedContributions - plan.buffer;
  const spendingLimit =
    affordableLimit === null
      ? plan.spendingLimit
      : plan.spendingLimit === null
        ? affordableLimit
        : Math.min(affordableLimit, plan.spendingLimit);
  const allowance =
    spendingLimit === null
      ? null
      : spendingLimit - input.spending - activePending.spending - unpaidTotal;
  const forecastRemaining =
    incomeBasis === null
      ? null
      : incomeBasis - forecastSpending - reservedContributions - plan.buffer;
  const forecastOverrun =
    spendingLimit === null
      ? null
      : Math.max(0, forecastSpending - spendingLimit);
  const payday =
    plan.nextPayday && plan.nextPayday >= input.today ? plan.nextPayday : null;
  const billsBeforePayday = unpaidBills.filter(
    (bill) => !payday || bill.date < payday,
  );
  // The optional cash balance is explicitly a booked balance before pending payments.
  const cashBeforePayday =
    timing.status === "current" && plan.cashBalance !== null
      ? plan.cashBalance -
        activePending.outgoing -
        billsBeforePayday.reduce((sum, bill) => sum + bill.amount, 0) -
        plan.buffer
      : null;
  const remainingShares = prorate(
    paceCategories.map((row) => row.pace),
    variableRemaining,
  );
  const categories = paceCategories
    .map(({ pace, ...category }, index) => {
      const unpaid = unpaidBills
        .filter((bill) => bill.categoryId === category.id)
        .reduce((sum, bill) => sum + bill.amount, 0);
      const projected = category.amount + unpaid + remainingShares[index];
      return {
        ...category,
        projected,
        overrun:
          category.budget !== null
            ? Math.max(0, projected - category.budget)
            : 0,
      };
    })
    .sort(
      (a, b) =>
        b.overrun - a.overrun ||
        Number(b.flexible) - Number(a.flexible) ||
        b.amount - a.amount,
    );
  return {
    ...timing,
    investment,
    pension,
    unpaidBills,
    unpaidTotal,
    billsBeforePayday,
    cashBeforePayday,
    incomeBasis,
    spendingLimit,
    allowance,
    dailyAllowance:
      allowance === null || timing.remainingDays === 0
        ? null
        : Math.floor(Math.max(0, allowance) / timing.remainingDays),
    forecastSpending,
    variableSpent,
    variableRemaining,
    excludedFromPace: input.spending - variableSpent,
    forecastRemaining,
    forecastOverrun,
    surplus: input.income - input.spending,
    afterContributions:
      input.income - input.spending - input.investment.net - input.pension.net,
    categories,
  };
}

export type FinancialOverview = PlanningInputs & {
  cashUpdatedAt: string | null;
  saved: boolean;
  trend: MonthlyTotals[];
  comparison: { spending: number; months: number } | null;
  uncategorized: { count: number; amount: number };
  unallocatedCash: number;
  outlook: ReturnType<typeof spendingOutlook>;
};
