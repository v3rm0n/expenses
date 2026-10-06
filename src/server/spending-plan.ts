import { z } from "zod";
import {
  emptyPlan,
  spendingOutlook,
  monthTiming,
  type SpendingPlan,
  type FinancialOverview,
  type PlanCategory,
} from "../lib/spending-plan";
import { validDate } from "../lib/money";
import { query, transaction } from "./db";
import { dateWindow, overview, spendingAnalysis } from "./reporting";
import { AppError } from "./errors";

const amount = z.number().int().min(0).max(1_000_000_000_000);
const category = z
  .string()
  .regex(/^[\w-]{1,100}$/)
  .refine(
    (value) => !["investments", "pension"].includes(value),
    "Use contribution targets for investments and pensions.",
  );
export const spendingPlanSchema = z
  .object({
    income: amount.nullable(),
    spendingLimit: amount.nullable(),
    buffer: amount,
    investmentMonthly: amount,
    pensionMonthly: amount,
    investmentAnnual: amount,
    pensionAnnual: amount,
    cashBalance: z
      .number()
      .int()
      .min(-1_000_000_000_000)
      .max(1_000_000_000_000)
      .nullable(),
    nextPayday: z
      .string()
      .refine((value) => {
        try {
          validDate(value);
          return true;
        } catch {
          return false;
        }
      }, "Enter a valid payday.")
      .nullable(),
    budgets: z
      .array(
        z
          .object({ categoryId: category, amount, flexible: z.boolean() })
          .strict(),
      )
      .max(100),
    bills: z
      .array(
        z
          .object({
            id: z.uuid(),
            name: z.string().trim().min(1).max(100),
            amount: amount.positive(),
            dueDay: z.number().int().min(1).max(31),
            status: z.enum(["unpaid", "pending", "paid"]),
            categoryId: category.nullable(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (
      new Set(plan.budgets.map((row) => row.categoryId)).size !==
      plan.budgets.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Each category can have one budget.",
        path: ["budgets"],
      });
    if (new Set(plan.bills.map((row) => row.id)).size !== plan.bills.length)
      ctx.addIssue({
        code: "custom",
        message: "Bills must have unique IDs.",
        path: ["bills"],
      });
  });

export async function loadSpendingPlan(month: string, currency: string) {
  dateWindow(month);
  const rows = await query(
    "SELECT key,value,updated_at FROM settings WHERE key IN ($1,$2)",
    [
      `spending-plan:${currency}:${month}`,
      `annual-goals:${currency}:${month.slice(0, 4)}`,
    ],
  );
  const monthly = rows.find((row) => row.key.startsWith("spending-plan:"));
  const annual = rows.find((row) => row.key.startsWith("annual-goals:"));
  const plan: SpendingPlan = {
    ...emptyPlan(),
    ...monthly?.value.plan,
    ...annual?.value,
  };
  return {
    plan,
    saved: Boolean(monthly),
    cashUpdatedAt: monthly?.value.cashUpdatedAt ?? null,
  };
}

export async function saveSpendingPlan(
  month: string,
  currency: string,
  input: unknown,
) {
  dateWindow(month);
  const plan = spendingPlanSchema.parse(input);
  if (plan.nextPayday && plan.nextPayday < `${month}-01`)
    throw new AppError("Payday must be in or after the selected month.");
  const ids = [
    ...plan.budgets.map((row) => row.categoryId),
    ...plan.bills.flatMap((row) => (row.categoryId ? [row.categoryId] : [])),
  ];
  if (ids.length) {
    const rows = await query(
      "SELECT id FROM categories WHERE id=ANY($1::text[])",
      [ids],
    );
    if (ids.some((id) => !rows.some((row) => row.id === id)))
      throw new AppError("Choose existing spending categories.");
  }
  return transaction(async (db) => {
    const key = `spending-plan:${currency}:${month}`;
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
    const [previous] = await query(
      "SELECT value FROM settings WHERE key=$1",
      [key],
      db,
    );
    const cashUpdatedAt =
      plan.cashBalance === null
        ? null
        : previous?.value.plan.cashBalance === plan.cashBalance
          ? previous.value.cashUpdatedAt
          : new Date().toISOString();
    const { investmentAnnual, pensionAnnual, ...monthly } = plan;
    for (const [settingKey, value] of [
      [key, { plan: monthly, cashUpdatedAt }],
      [
        `annual-goals:${currency}:${month.slice(0, 4)}`,
        { investmentAnnual, pensionAnnual },
      ],
    ] as const)
      await db.query(
        "INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()",
        [settingKey, JSON.stringify(value)],
      );
    return { plan, saved: true, cashUpdatedAt };
  });
}

export async function financialOverview(
  month: string,
  currency: string,
): Promise<FinancialOverview> {
  const today = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Tallinn",
  }).format(new Date());
  const { from, to } = dateWindow(month);
  const timing = monthTiming(month, today);
  const priorFrom = new Date(`${from}T12:00:00Z`);
  priorFrom.setUTCMonth(priorFrom.getUTCMonth() - 3);
  const [
    saved,
    summary,
    analysis,
    annual,
    pendingRows,
    comparisonRows,
    categoryRows,
  ] = await Promise.all([
    loadSpendingPlan(month, currency),
    overview(month, currency),
    spendingAnalysis(month, currency, 6),
    query<{ investment: number; pension: number }>(
      `SELECT coalesce(sum(-amount) FILTER(WHERE kind='investment'),0)::bigint AS investment,coalesce(sum(-amount) FILTER(WHERE kind='pension'),0)::bigint AS pension FROM ledger_transactions WHERE status='BOOK' AND currency=$1 AND booked_at >= $2 AND booked_at < $3`,
      [currency, `${month.slice(0, 4)}-01-01`, to],
    ),
    query<{
      spending: number;
      investment: number;
      pension: number;
      outgoing: number;
      count: number;
    }>(
      `SELECT coalesce(sum(-amount) FILTER(WHERE kind='expense' AND amount<0),0)::bigint AS spending,coalesce(sum(-amount) FILTER(WHERE kind='investment' AND amount<0),0)::bigint AS investment,coalesce(sum(-amount) FILTER(WHERE kind='pension' AND amount<0),0)::bigint AS pension,coalesce(sum(-amount) FILTER(WHERE amount<0 AND kind NOT IN ('transfer','cash_movement')),0)::bigint AS outgoing,count(*)::int AS count FROM transactions WHERE status='PDNG' AND currency=$1`,
      [currency],
    ),
    query<{ spending: number }>(
      `SELECT coalesce(sum(-amount) FILTER(WHERE kind IN ('expense','refund')),0)::bigint AS spending FROM ledger_transactions WHERE status='BOOK' AND currency=$1 AND booked_at >= $2 AND booked_at < $3 AND extract(day FROM booked_at)<=$4 GROUP BY date_trunc('month',booked_at)`,
      [
        currency,
        priorFrom.toISOString().slice(0, 10),
        from,
        timing.status === "current" ? timing.elapsed : 31,
      ],
    ),
    query<PlanCategory>(
      "SELECT id,name,color,0::bigint AS amount FROM categories ORDER BY name",
    ),
  ]);
  const categories = categoryRows.map((row) => ({
    ...row,
    amount: summary.categories.find((item) => item.id === row.id)?.amount ?? 0,
  }));
  const input = {
    month,
    today,
    plan: saved.plan,
    spending: summary.spending,
    income: summary.income,
    investment: summary.investment,
    pension: summary.pension,
    yearInvestment: annual[0].investment,
    yearPension: annual[0].pension,
    pending: pendingRows[0],
    categories,
  };
  return {
    ...input,
    ...saved,
    trend: analysis.months,
    comparison: comparisonRows.length
      ? {
          spending: Math.round(
            comparisonRows.reduce((sum, row) => sum + row.spending, 0) /
              comparisonRows.length,
          ),
          months: comparisonRows.length,
        }
      : null,
    uncategorized: {
      count: summary.uncategorized.count,
      amount: summary.uncategorized.amount,
    },
    unallocatedCash: summary.cash.amount,
    outlook: spendingOutlook(input),
  };
}
