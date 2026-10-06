export type Contributions = {
  contributed: number;
  withdrawn: number;
  net: number;
  history_contributed: number;
  history_withdrawn: number;
  history_net: number;
};

export type MonthlyTotals = {
  month: string;
  spending: number;
  income: number;
  investment: number;
  pension: number;
};

export function netCashFlow(point: MonthlyTotals) {
  return point.income - point.spending - point.investment - point.pension;
}

export function cumulativeCashFlow(months: MonthlyTotals[]) {
  let total = 0;
  return months.map((point) => ({
    ...point,
    cumulativeNetCashFlow: (total += netCashFlow(point)),
  }));
}

export type SpendingAnalysis = {
  month: string;
  currency: string;
  from: string;
  to: string;
  months: MonthlyTotals[];
  investment: Contributions;
  pension: Contributions;
  categories: Array<{
    month: string;
    id: string;
    name: string;
    color: string;
    amount: number;
  }>;
  merchants: Array<{
    month: string;
    category_id: string;
    merchant: string;
    amount: number;
  }>;
};

export function analysisBreakdown(
  data: SpendingAnalysis,
  month = "",
  category = "",
) {
  const categories = new Map<
    string,
    { id: string; name: string; color: string; amount: number }
  >();
  for (const row of data.categories) {
    if (month && row.month !== month) continue;
    const total = categories.get(row.id) || { ...row, amount: 0 };
    total.amount += row.amount;
    categories.set(row.id, total);
  }
  const merchants = new Map<string, number>();
  for (const row of data.merchants) {
    if (month && row.month !== month) continue;
    if (category && row.category_id !== category) continue;
    merchants.set(
      row.merchant,
      (merchants.get(row.merchant) || 0) + row.amount,
    );
  }
  return {
    categories: [...categories.values()].sort((a, b) => b.amount - a.amount),
    merchants: [...merchants]
      .map(([merchant, amount]) => ({ merchant, amount }))
      .sort((a, b) => b.amount - a.amount),
    categoryTrend: data.months.map((point) => ({
      month: point.month,
      amount: data.categories.reduce(
        (sum, row) =>
          sum +
          (row.month === point.month && (!category || row.id === category)
            ? row.amount
            : 0),
        0,
      ),
    })),
  };
}
