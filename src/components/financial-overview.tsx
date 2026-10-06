"use client";
import {
  ArrowUpRight,
  CalendarDays,
  Landmark,
  Target,
  WalletCards,
} from "lucide-react";
import { monthLabel } from "../lib/dates";
import { formatMoney } from "../lib/money";
import type { FinancialOverview } from "../lib/spending-plan";
import {
  useData,
  Loading,
  ErrorMessage,
  SectionTitle,
  TextLink,
  dateTime,
  shortDate,
  type AppContext,
} from "./ui";

export function GoalProgress({
  data,
  currency,
}: {
  data: FinancialOverview;
  currency: string;
}) {
  const fmt = (amount: number) => formatMoney(amount, currency);
  return (
    <div className="goal-cards">
      {(["investment", "pension"] as const).map((kind) => {
        const goal = data.outlook[kind];
        return (
          <article className="goal-card" key={kind}>
            <div className="goal-heading">
              <Landmark size={18} />
              <h3>{kind === "investment" ? "Investments" : "Pension"}</h3>
              <span className="muted small">
                {goal.target > 0
                  ? goal.remaining === 0
                    ? goal.net >= goal.target
                      ? "Funded"
                      : "Pending completion"
                    : "Contribution needed"
                  : goal.annual > 0
                    ? "Annual goal funded"
                    : "No target set"}
              </span>
            </div>
            <p className="goal-amount">
              <strong>{fmt(goal.net)}</strong>
              <span>
                {goal.target > 0
                  ? ` / ${fmt(goal.target)} this month`
                  : " contributed this month"}
              </span>
            </p>
            <div
              className="progress"
              role="progressbar"
              aria-label={`${kind === "investment" ? "Investment" : "Pension"} monthly progress`}
              aria-valuenow={Math.round(goal.monthlyPercent)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <i style={{ width: `${goal.monthlyPercent}%` }} />
            </div>
            <p className="form-help">
              {goal.target > 0
                ? `${fmt(goal.remaining)} still to contribute`
                : goal.annual > 0
                  ? "Annual goal reached. Add a monthly target to keep contributing."
                  : "Set a monthly or annual contribution target."}
              {goal.pending > 0 && ` · ${fmt(goal.pending)} pending`}
            </p>
            {goal.annual > 0 && (
              <>
                <p className="goal-annual">
                  {fmt(goal.yearNet)} / {fmt(goal.annual)} in{" "}
                  {data.month.slice(0, 4)}
                </p>
                <div
                  className="progress"
                  role="progressbar"
                  aria-label={`${kind === "investment" ? "Investment" : "Pension"} annual progress`}
                  aria-valuenow={Math.round(goal.annualPercent)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <i style={{ width: `${goal.annualPercent}%` }} />
                </div>
                <p className="form-help">
                  {fmt(goal.annualRemaining)} remaining this year · monthly
                  target includes the pace needed to reach it.
                </p>
              </>
            )}
          </article>
        );
      })}
    </div>
  );
}

export function FinancialOverviewView({
  context: ctx,
}: {
  context: AppContext;
}) {
  const { data, error, loading } = useData<FinancialOverview>(
    `financial-overview?month=${ctx.month}&currency=${ctx.currency}`,
    ctx.revision,
    30000,
  );
  if (!data)
    return (
      <>
        <ErrorMessage message={error} />
        {loading && <Loading />}
      </>
    );
  const outlook = data.outlook;
  const fmt = (amount: number) => formatMoney(amount, ctx.currency);
  const current = outlook.status === "current";
  const past = outlook.status === "past";
  const allowance = outlook.allowance;
  const overrun = outlook.forecastOverrun ?? 0;
  const bankAccounts = ctx.state.accounts.filter(
    (account) =>
      account.source === "bank" &&
      (!account.currency || account.currency === ctx.currency),
  );
  const syncs = bankAccounts
    .flatMap((account) => (account.last_sync_at ? [account.last_sync_at] : []))
    .sort();
  const stale =
    current &&
    bankAccounts.some(
      (account) =>
        !account.last_sync_at ||
        Date.now() - new Date(account.last_sync_at).getTime() > 48 * 3600000,
    );
  const categories = outlook.categories
    .filter((row) => row.amount !== 0 || row.budget !== null || row.overrun > 0)
    .slice(0, 5);
  const query = `from=${ctx.month}-01&to=${ctx.month}-${String(outlook.days).padStart(2, "0")}&currency=${ctx.currency}`;
  const trendMax = Math.max(
    1,
    ...data.trend.map((point) => Math.abs(point.income - point.spending)),
  );
  const forecastActive = current && outlook.elapsed >= 3;
  return (
    <div className="view-stack financial-overview">
      <ErrorMessage message={error} />
      <div className="overview-context">
        <span>
          {monthLabel(ctx.month)} ·{" "}
          {past
            ? "Completed month"
            : current
              ? `${outlook.remainingDays} days remaining`
              : "Planned month"}
        </span>
        <TextLink onClick={() => ctx.navigate("/goals")}>
          Edit spending plan
        </TextLink>
      </div>
      {!bankAccounts.length && (
        <div className="notice">
          Connect your bank for a fuller overview, or keep recording cash
          entries.{" "}
          <TextLink onClick={() => ctx.navigate("/connections")}>
            Connect a bank
          </TextLink>
        </div>
      )}
      <section
        className={`allowance-panel ${allowance !== null && allowance < 0 ? "is-negative" : ""}`}
        aria-label="Spending allowance"
      >
        <div>
          <span className="eyebrow">
            {past
              ? "MONTH-END SPENDING HEADROOM"
              : "REMAINING SPENDING ALLOWANCE"}
          </span>
          <h2>
            {allowance === null
              ? "Give your money a plan"
              : allowance < 0
                ? `${fmt(-allowance)} short of your plan`
                : `${fmt(allowance)} ${past ? "under your limit" : "left to spend"}`}
          </h2>
          <p>
            {allowance === null
              ? "Set expected take-home income, bills, and contribution targets to see what you can afford."
              : outlook.incomeBasis === null
                ? "Budget headroom only. Set expected income to check affordability and contribution goals."
                : "After reserving your contribution targets, unpaid bills, pending spending, and a buffer."}
          </p>
        </div>
        {!past && outlook.dailyAllowance !== null && (
          <div className="allowance-pace">
            <strong>
              {fmt(outlook.dailyAllowance * Math.min(7, outlook.remainingDays))}
            </strong>
            <span>for the next {Math.min(7, outlook.remainingDays)} days</span>
            <small>{fmt(outlook.dailyAllowance)} per day</small>
          </div>
        )}
      </section>
      {current &&
        outlook.cashBeforePayday !== null &&
        outlook.cashBeforePayday < 0 && (
          <div className="notice planning-warning">
            <p>
              Your recorded cash balance is {fmt(-outlook.cashBeforePayday)}{" "}
              short of bills, pending payments, and buffer before payday. The
              monthly allowance includes expected income that may not have
              arrived yet.
            </p>
          </div>
        )}
      {!data.saved && (
        <div className="notice">
          No plan saved for this month. Figures use received income and recorded
          spending until you add a plan.{" "}
          <TextLink onClick={() => ctx.navigate("/goals")}>
            Set up this month
          </TextLink>
        </div>
      )}
      <div className="metric-grid financial-metrics">
        <OverviewMetric
          label="LIVING EXPENSES"
          amount={data.spending}
          currency={ctx.currency}
          caption={`${fmt(data.income)} income received · refunds included`}
          icon={<ArrowUpRight size={16} />}
        />
        <OverviewMetric
          label="SURPLUS BEFORE CONTRIBUTIONS"
          amount={outlook.surplus}
          currency={ctx.currency}
          caption="Received income minus living expenses"
          icon={<WalletCards size={16} />}
        />
        <OverviewMetric
          label="REMAINING AFTER CONTRIBUTIONS"
          amount={outlook.afterContributions}
          currency={ctx.currency}
          caption="Actual surplus after net investments and pension"
          icon={<Target size={16} />}
        />
        <OverviewMetric
          label={past ? "SPENDING LIMIT" : "EXPECTED MONTH-END SPENDING"}
          amount={
            past
              ? outlook.spendingLimit
              : forecastActive
                ? outlook.forecastSpending
                : null
          }
          currency={ctx.currency}
          caption={
            past
              ? "Income and goal commitments, capped by your limit"
              : forecastActive
                ? outlook.spendingLimit === null
                  ? "Estimate · set income or a limit to check your pace"
                  : overrun > 0
                    ? `Estimate · ${fmt(overrun)} over your limit`
                    : `Estimate · ${fmt(outlook.spendingLimit - outlook.forecastSpending)} under your limit`
                : current
                  ? "Forecast starts after three days of this month"
                  : "Forecast available once this month is underway"
          }
          icon={<CalendarDays size={16} />}
        />
      </div>
      {current && forecastActive && outlook.forecastRemaining !== null && (
        <div className={`notice ${overrun > 0 ? "planning-warning" : ""}`}>
          <p>
            {overrun > 0
              ? `At the current pace, reduce remaining spending by ${fmt(overrun)} to stay within your limit.`
              : "Your current spending pace fits your income and contribution plan."}{" "}
            Estimated month-end balance from this month’s income after goals and
            buffer: <strong>{fmt(outlook.forecastRemaining)}</strong>.
          </p>
        </div>
      )}
      <section className="panel">
        <SectionTitle
          title="Goal progress"
          description="Net contributions, including money returned. Targets stay visible even before your first contribution."
          action={
            <TextLink onClick={() => ctx.navigate("/goals")}>
              Manage goals
            </TextLink>
          }
        />
        <GoalProgress data={data} currency={ctx.currency} />
      </section>
      <div className="planning-columns">
        <section className="panel">
          <SectionTitle
            title="Where to adjust spending"
            description={planDescription(data)}
            action={
              <TextLink onClick={() => ctx.navigate("/analysis")}>
                Spending analysis
              </TextLink>
            }
          />
          {categories.length ? (
            <div className="planning-category-list">
              {categories.map((row) => (
                <button
                  key={row.id}
                  onClick={() =>
                    ctx.navigate(`/transactions?category=${row.id}&${query}`)
                  }
                >
                  <div className="planning-category-heading">
                    <span>
                      <i style={{ background: row.color }} />
                      {row.name}
                      {!row.flexible && <small> · committed</small>}
                    </span>
                    <strong>{fmt(row.amount)}</strong>
                  </div>
                  <div className="planning-category-caption">
                    <span>
                      {row.budget === null
                        ? "No category limit"
                        : `${fmt(row.budget)} budget`}
                    </span>
                    <span className={row.overrun > 0 ? "negative" : "muted"}>
                      {row.overrun > 0
                        ? `${fmt(row.overrun)} ${current ? "projected over" : "over"}`
                        : row.budget !== null
                          ? `${fmt(Math.max(0, row.budget - row.amount))} unspent`
                          : current
                            ? `${fmt(row.projected)} projected`
                            : "Booked spending"}
                    </span>
                  </div>
                  {row.budget !== null && row.budget > 0 && (
                    <div className="progress">
                      <i
                        style={{
                          width: `${Math.max(0, Math.min(100, (row.amount / row.budget) * 100))}%`,
                          background:
                            row.overrun > 0 ? "var(--danger)" : undefined,
                        }}
                      />
                    </div>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <p className="planning-empty">
              Record expenses or add category limits to see where to adjust.
            </p>
          )}
          {!data.plan.budgets.length && (
            <div className="planning-footer">
              <TextLink onClick={() => ctx.navigate("/goals")}>
                Add category limits
              </TextLink>
            </div>
          )}
        </section>
        <section className="panel">
          <SectionTitle
            title={past ? "Recorded commitments" : "Upcoming commitments"}
            description="Mark bills paid in your plan once their payments are booked, so they are counted once."
            action={
              <TextLink onClick={() => ctx.navigate("/goals")}>
                Manage bills
              </TextLink>
            }
          />
          <div className="commitment-list">
            {outlook.unpaidBills.map((bill) => (
              <div key={bill.id}>
                <div>
                  <strong>{bill.name}</strong>
                  <small>
                    {shortDate(bill.date)}
                    {current && bill.date < data.today
                      ? " · overdue or not marked paid"
                      : ""}
                  </small>
                </div>
                <strong>{fmt(bill.amount)}</strong>
              </div>
            ))}
            {!past && outlook.investment.remaining > 0 && (
              <div>
                <div>
                  <strong>Investment contribution</strong>
                  <small>Remaining goal this month</small>
                </div>
                <strong>{fmt(outlook.investment.remaining)}</strong>
              </div>
            )}
            {!past && outlook.pension.remaining > 0 && (
              <div>
                <div>
                  <strong>Pension contribution</strong>
                  <small>Remaining goal this month</small>
                </div>
                <strong>{fmt(outlook.pension.remaining)}</strong>
              </div>
            )}
            {!outlook.unpaidBills.length &&
              (past ||
                outlook.investment.remaining + outlook.pension.remaining ===
                  0) && (
                <p className="planning-empty">
                  {past
                    ? "See your plan for this month’s bill checklist."
                    : "No unpaid commitments recorded. Add bills to make your allowance more complete."}
                </p>
              )}
          </div>
          {current && (
            <div
              className={`cash-check ${outlook.cashBeforePayday !== null && outlook.cashBeforePayday < 0 ? "planning-warning" : ""}`}
            >
              <strong>
                Cash check
                {data.plan.nextPayday && data.plan.nextPayday >= data.today
                  ? ` before ${shortDate(data.plan.nextPayday)}`
                  : " this month"}
              </strong>
              <p>
                {outlook.cashBeforePayday === null
                  ? "Add your booked cash balance and next payday to check coverage."
                  : outlook.cashBeforePayday < 0
                    ? `${fmt(-outlook.cashBeforePayday)} short for recorded bills, pending payments, and buffer.`
                    : `${fmt(outlook.cashBeforePayday)} left after recorded bills, pending payments, and buffer.`}
              </p>
              <small>
                {data.cashUpdatedAt
                  ? `Cash balance entered ${dateTime(data.cashUpdatedAt)}. `
                  : ""}
                This check excludes income not yet received and contributions
                without a due date.
                {data.plan.nextPayday &&
                  data.plan.nextPayday < data.today &&
                  " Your recorded payday has passed; update it. Until then, all unpaid bills this month are reserved."}
              </small>
            </div>
          )}
        </section>
      </div>
      <section className="panel">
        <SectionTitle
          title="Recent spending balance"
          description="Income minus living expenses each month, before contributions."
          action={
            <TextLink onClick={() => ctx.navigate("/analysis")}>
              Explore history
            </TextLink>
          }
        />
        <div className="surplus-trend">
          {data.trend.map((point) => {
            const surplus = point.income - point.spending;
            const width = (Math.abs(surplus) / trendMax) * 48;
            return (
              <button
                key={point.month}
                onClick={() => ctx.setMonth(point.month)}
              >
                <span>
                  {monthLabel(point.month, true)}
                  {point.month === data.today.slice(0, 7) ? " · so far" : ""}
                </span>
                <span className="surplus-track" aria-hidden="true">
                  <i
                    className={surplus < 0 ? "deficit" : ""}
                    style={{
                      left: `${surplus < 0 ? 50 - width : 50}%`,
                      width: `${width}%`,
                    }}
                  />
                </span>
                <strong className={surplus < 0 ? "negative" : ""}>
                  {fmt(surplus)}
                </strong>
              </button>
            );
          })}
        </div>
        {data.comparison && outlook.status !== "future" && (
          <p className="planning-footer muted">
            Spending is{" "}
            {fmt(Math.abs(data.spending - data.comparison.spending))}{" "}
            {data.spending > data.comparison.spending ? "above" : "below"} the
            average of {data.comparison.months} earlier{" "}
            {current
              ? `months through day ${outlook.elapsed}`
              : "completed months"}{" "}
            with imported activity.
          </p>
        )}
      </section>
      {(data.uncategorized.count > 0 ||
        data.unallocatedCash > 0 ||
        (current && data.pending.count > 0)) && (
        <div className="notice planning-data-note">
          <strong>Figures may change</strong>
          <span>
            {data.uncategorized.count > 0 &&
              `${fmt(data.uncategorized.amount)} in ${data.uncategorized.count} uncategorized payments. `}
            {data.unallocatedCash > 0 &&
              `${fmt(data.unallocatedCash)} in cash still needs allocation; it is not counted as spending until purchases are recorded. `}
            {current &&
              data.pending.count > 0 &&
              `${fmt(data.pending.outgoing)} outgoing pending payments; expense and contribution payments are reserved in the plan. `}
          </span>
          <TextLink onClick={() => ctx.navigate(`/review?${query}`)}>
            Review payments
          </TextLink>
        </div>
      )}
      <p className={`planning-footnote ${stale ? "negative" : ""}`}>
        {bankAccounts.length
          ? syncs.length
            ? `Oldest account sync: ${dateTime(syncs[0])}. ${stale ? "Some accounts are missing a recent sync. Refresh Connections before relying on estimates. " : ""}`
            : "Bank accounts have not been synced. "
          : "Based on manual entries. "}
        Forecasts assume your recorded variable spending pace continues. Paid
        bills are excluded from that pace. Missing bills, imports, or
        classifications can change the result.{" "}
        <TextLink onClick={() => ctx.navigate("/connections")}>
          Connections
        </TextLink>
      </p>
    </div>
  );
}

function planDescription(data: FinancialOverview) {
  return data.plan.budgets.length
    ? "Largest expected overruns first. Flexible categories offer the clearest opportunities to cut back."
    : "Your largest categories. Add limits to highlight expected overruns.";
}

function OverviewMetric({
  label,
  amount,
  currency,
  caption,
  icon,
}: {
  label: string;
  amount: number | null;
  currency: string;
  caption: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="metric">
      <div className="metric-label">
        {label}
        <span>{icon}</span>
      </div>
      <div
        className={`metric-value ${amount !== null && amount < 0 ? "negative" : ""}`}
      >
        {amount === null ? "—" : formatMoney(amount, currency)}
      </div>
      <div className="metric-caption">{caption}</div>
    </div>
  );
}

export function ReceiptCoverage({ context: ctx }: { context: AppContext }) {
  const { data, error } = useData<{
    receipt_required_count: number;
    receipt_count: number;
    receipt_excluded_count: number;
  }>(
    `overview?month=${ctx.month}&currency=${ctx.currency}`,
    ctx.revision,
    30000,
  );
  if (!data) return <ErrorMessage message={error} />;
  const percent = data.receipt_required_count
    ? Math.round((data.receipt_count / data.receipt_required_count) * 100)
    : null;
  return (
    <section className="panel receipt-coverage-summary">
      <SectionTitle
        title="Receipt coverage"
        description={`${monthLabel(ctx.month)} · ${ctx.currency} · ${data.receipt_required_count ? `${data.receipt_count} of ${data.receipt_required_count} required payments linked (${percent}%)` : "No receipts required"}${data.receipt_excluded_count ? ` · ${data.receipt_excluded_count} exempt payments` : ""}`}
        action={
          <TextLink
            onClick={() =>
              ctx.navigate(
                `/transactions?month=${ctx.month}&currency=${ctx.currency}&receipt=missing`,
              )
            }
          >
            Find missing receipts
          </TextLink>
        }
      />
      <ErrorMessage message={error} />
    </section>
  );
}
