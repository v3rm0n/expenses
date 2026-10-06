"use client";
import { useId, useState, type KeyboardEvent } from "react";
import {
  ArrowUpRight,
  ArrowDownLeft,
  WalletCards,
  CalendarDays,
  Landmark,
} from "lucide-react";
import { currencyScale, formatMoney } from "../lib/money";
import { monthLabel } from "../lib/dates";
import {
  analysisBreakdown,
  cumulativeCashFlow,
  type SpendingAnalysis,
  type MonthlyTotals,
} from "../lib/spending-analysis";
import {
  useData,
  Loading,
  ErrorMessage,
  Empty,
  SectionTitle,
  TextLink,
  type AppContext,
} from "./ui";

const activate = (event: KeyboardEvent<SVGGElement>, action: () => void) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
};

export function PeriodOverview({
  context: ctx,
  months,
}: {
  context: AppContext;
  months: number;
}) {
  const { data, error, loading } = useData<SpendingAnalysis>(
    `spending-analysis?month=${ctx.month}&currency=${ctx.currency}&months=${months}`,
    ctx.revision,
    30000,
  );
  const [selectedMonth, setSelectedMonth] = useState("");
  const [category, setCategory] = useState("");
  const [merchant, setMerchant] = useState("");
  const [merchantLimit, setMerchantLimit] = useState(10);
  if (!data)
    return (
      <>
        <ErrorMessage message={error} />
        {loading && <Loading />}
      </>
    );
  const fmt = (value: number) => formatMoney(value, ctx.currency);
  const totals = data.months.reduce(
    (sum, point) => ({
      spending: sum.spending + point.spending,
      income: sum.income + point.income,
      contributions: sum.contributions + point.investment + point.pension,
    }),
    { spending: 0, income: 0, contributions: 0 },
  );
  const allCategories = analysisBreakdown(data).categories;
  const breakdown = analysisBreakdown(data, selectedMonth, category);
  const selectedCategory = allCategories.find((row) => row.id === category);
  const categoryName = selectedCategory?.name || "All categories";
  const periodLabel = selectedMonth
    ? monthLabel(selectedMonth)
    : months === 1
      ? "Entire month"
      : `All ${months} months`;
  const selectMonth = (value: string) => {
    setSelectedMonth(value === selectedMonth ? "" : value);
    setMerchant("");
  };
  const selectCategory = (value: string) => {
    setCategory(value === category ? "" : value);
    setMerchant("");
  };
  const merchantRows = breakdown.merchants.filter((row) => row.amount !== 0);
  const selectedMerchant = merchantRows.find(
    (row) => row.merchant === merchant,
  );
  const merchantMax = Math.max(
    ...merchantRows.map((row) => Math.abs(row.amount)),
    1,
  );
  const positiveCategories = breakdown.categories.filter(
    (row) => row.amount > 0,
  );
  const positiveTotal = positiveCategories.reduce(
    (sum, row) => sum + row.amount,
    0,
  );
  const breakdownTotal = breakdown.categories.reduce(
    (sum, row) => sum + row.amount,
    0,
  );
  let offset = 0;
  const segments = positiveCategories.map((row) => {
    const span = (row.amount / positiveTotal) * 100;
    const segment = { ...row, span, offset };
    offset += span;
    return segment;
  });
  return (
    <div className="view-stack analysis-view">
      <ErrorMessage message={error} />
      <div className="analysis-period">
        <div>
          <strong>
            {months === 1
              ? monthLabel(ctx.month)
              : `${monthLabel(data.months[0].month)} – ${monthLabel(ctx.month)}`}
          </strong>
          <p>
            {months === 1 ? "One calendar month" : `${months} calendar months`}{" "}
            ending in the selected month. The current month may be incomplete.
          </p>
        </div>
      </div>
      <div className="metric-grid">
        <Metric
          label="NET SPENDING"
          value={fmt(totals.spending)}
          caption="Booked expenses minus refunds"
          icon={<ArrowUpRight size={16} />}
          featured
        />
        <Metric
          label="INCOME"
          value={fmt(totals.income)}
          caption="Incoming payments, excluding transfers"
          icon={<ArrowDownLeft size={16} />}
        />
        <Metric
          label="MONTHLY AVERAGE"
          value={fmt(Math.round(totals.spending / months))}
          caption={`Net spending divided by ${months} ${months === 1 ? "month" : "months"}`}
          icon={<CalendarDays size={16} />}
        />
        <Metric
          label="NET CASH FLOW"
          value={fmt(totals.income - totals.spending - totals.contributions)}
          caption={`${fmt(totals.contributions)} net investment & pension contributions included`}
          icon={<WalletCards size={16} />}
        />
      </div>
      <section className="panel">
        <SectionTitle
          title="Spending and income"
          description="Monthly spending and income, with cumulative net cash flow after spending, refunds, and investment and pension contributions. Select a month to explore its breakdowns."
        />
        <CashFlowChart
          months={data.months}
          currency={ctx.currency}
          selected={selectedMonth}
          onSelect={selectMonth}
        />
        <div className="analysis-note">
          Spending includes refunds. Transfers are excluded. Investment and
          pension contributions affect net cash flow, not spending.
        </div>
      </section>
      <div className="analysis-filters">
        <label>
          Breakdown period
          <select
            aria-label="Breakdown period"
            value={selectedMonth}
            onChange={(event) => {
              setSelectedMonth(event.target.value);
              setMerchant("");
            }}
          >
            <option value="">
              {months === 1 ? "Entire month" : `All ${months} months`}
            </option>
            {data.months.map((point) => (
              <option key={point.month} value={point.month}>
                {monthLabel(point.month)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Category
          <select
            aria-label="Analysis category"
            value={category}
            onChange={(event) => {
              setCategory(event.target.value);
              setMerchant("");
            }}
          >
            {[
              <option key="all" value="">
                All categories
              </option>,
              ...allCategories.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              )),
            ]}
          </select>
        </label>
        {(selectedMonth || category) && (
          <button
            className="button subtle"
            onClick={() => {
              setSelectedMonth("");
              setCategory("");
              setMerchant("");
            }}
          >
            Reset filters
          </button>
        )}
        <span className="muted small" role="status">
          {periodLabel} · {categoryName}
        </span>
      </div>
      <div className="analysis-grid">
        <section className="panel analysis-category-panel">
          <SectionTitle
            title="Where the money goes"
            description={`${periodLabel} · select a category to explore its trend and merchants.`}
          />
          {breakdown.categories.length ? (
            <>
              <div className="donut-wrap analysis-donut">
                <svg
                  viewBox="0 0 200 200"
                  aria-label="Spending share by category"
                >
                  <circle
                    cx="100"
                    cy="100"
                    r="76"
                    fill="none"
                    stroke="#edf1e7"
                    strokeWidth="22"
                  />
                  {segments.map((segment) => (
                    <g
                      key={segment.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`Filter ${segment.name}: ${fmt(segment.amount)}, ${segment.span.toFixed(1)}%`}
                      aria-pressed={category === segment.id}
                      className="analysis-mark"
                      onClick={() => selectCategory(segment.id)}
                      onKeyDown={(event) =>
                        activate(event, () => selectCategory(segment.id))
                      }
                    >
                      <title>
                        {segment.name}: {fmt(segment.amount)} (
                        {segment.span.toFixed(1)}%)
                      </title>
                      <circle
                        cx="100"
                        cy="100"
                        r="76"
                        fill="none"
                        stroke={segment.color}
                        strokeWidth={category === segment.id ? 28 : 22}
                        opacity={category && category !== segment.id ? 0.35 : 1}
                        pathLength="100"
                        strokeDasharray={`${segment.span} ${100 - segment.span}`}
                        strokeDashoffset={-segment.offset}
                        transform="rotate(-90 100 100)"
                      />
                    </g>
                  ))}
                </svg>
                <div className="donut-center">
                  <span>NET SPENDING</span>
                  <strong>{fmt(breakdownTotal)}</strong>
                  <small>{periodLabel}</small>
                </div>
              </div>
              <div className="analysis-category-list">
                {breakdown.categories.map((row) => (
                  <button
                    key={row.id}
                    className={category === row.id ? "selected" : ""}
                    aria-pressed={category === row.id}
                    onClick={() => selectCategory(row.id)}
                  >
                    <span className="analysis-category-name">
                      <i style={{ background: row.color }} />
                      {row.name}
                    </span>
                    <span>
                      <strong>{fmt(row.amount)}</strong>
                      <small>
                        {row.amount > 0
                          ? `${((row.amount / positiveTotal) * 100).toFixed(1)}%`
                          : row.amount < 0
                            ? "Net refunds"
                            : "Fully refunded"}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
              {breakdown.categories.some((row) => row.amount < 0) && (
                <div className="analysis-note">
                  The ring shows categories with positive net spending.
                  Categories with net refunds are listed separately and reduce
                  the total.
                </div>
              )}
            </>
          ) : (
            <Empty
              title="No spending in this period"
              text="Select another month or import transactions to see category shares."
            />
          )}
        </section>
        <section className="panel">
          <SectionTitle
            title="Top merchants"
            description={`${periodLabel} · ${categoryName}. Select a merchant for monthly totals.`}
            action={
              <select
                aria-label="Number of merchants"
                value={merchantLimit}
                onChange={(event) =>
                  setMerchantLimit(Number(event.target.value))
                }
              >
                <option value={10}>Top 10</option>
                <option value={20}>Top 20</option>
                <option value={0}>All</option>
              </select>
            }
          />
          {merchantRows.length ? (
            <div className="analysis-merchants">
              {merchantRows
                .slice(0, merchantLimit || undefined)
                .map((row, index) => (
                  <button
                    key={row.merchant}
                    aria-pressed={merchant === row.merchant}
                    className={`analysis-merchant ${merchant === row.merchant ? "selected" : ""}`}
                    onClick={() =>
                      setMerchant(row.merchant === merchant ? "" : row.merchant)
                    }
                  >
                    <span className="analysis-merchant-heading">
                      <span>
                        {index + 1}. {row.merchant || "Unknown merchant"}
                      </span>
                      <strong className={row.amount < 0 ? "negative" : ""}>
                        {fmt(row.amount)}
                      </strong>
                    </span>
                    <span className="analysis-horizontal-track">
                      <i
                        style={{
                          width: `${(Math.abs(row.amount) / merchantMax) * 100}%`,
                          background:
                            row.amount < 0
                              ? "var(--danger)"
                              : selectedCategory?.color || "var(--green)",
                        }}
                      />
                    </span>
                  </button>
                ))}
              {selectedMerchant && (
                <div className="analysis-merchant-detail" role="status">
                  <strong>
                    {selectedMerchant.merchant || "Unknown merchant"}
                  </strong>
                  <p>
                    {fmt(selectedMerchant.amount)} net spending · {periodLabel}{" "}
                    · {categoryName}
                  </p>
                  <div className="analysis-merchant-months">
                    {data.months.map((point) => {
                      const amount = data.merchants.reduce(
                        (sum, row) =>
                          sum +
                          (row.merchant === merchant &&
                          row.month === point.month &&
                          (!category || row.category_id === category)
                            ? row.amount
                            : 0),
                        0,
                      );
                      return (
                        <button
                          key={point.month}
                          onClick={() => selectMonth(point.month)}
                          aria-pressed={selectedMonth === point.month}
                        >
                          <small>{monthLabel(point.month, true)}</small>
                          <strong>{fmt(amount)}</strong>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <Empty
              title="No merchants in this selection"
              text="Try another month or category."
            />
          )}
        </section>
      </div>
      <section className="panel">
        <SectionTitle
          title="Category spending over time"
          description={`${categoryName} · net spending each month. Select a category above to follow its trend.`}
        />
        <CategoryTrend
          points={breakdown.categoryTrend}
          currency={ctx.currency}
          color={selectedCategory?.color || "var(--green)"}
          selected={selectedMonth}
          onSelect={selectMonth}
        />
      </section>
    </div>
  );
}

export function ContributionHistory({
  context: ctx,
  months,
}: {
  context: AppContext;
  months: number;
}) {
  const { data, error, loading } = useData<SpendingAnalysis>(
    `spending-analysis?month=${ctx.month}&currency=${ctx.currency}&months=${months}`,
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
  const fmt = (value: number) => formatMoney(value, ctx.currency);
  const periodEnd = new Date(
    new Date(`${data.to}T12:00:00Z`).getTime() - 86400000,
  )
    .toISOString()
    .slice(0, 10);
  const contributionKinds = [
    {
      kind: "investment",
      label: "INVESTMENT TRANSFERS",
      totals: data.investment,
    },
    { kind: "pension", label: "PENSION CONTRIBUTIONS", totals: data.pension },
  ].filter(
    ({ totals }) => totals.history_contributed || totals.history_withdrawn,
  );
  return (
    <>
      <ErrorMessage message={error} />{" "}
      {contributionKinds.length > 0 && (
        <section className="panel contributions-panel">
          <SectionTitle title="Contribution history" />
          <div className="metric-grid contribution-grid">
            {contributionKinds.map(({ kind, label, totals }) => (
              <div className="metric" key={kind}>
                <div className="metric-label">
                  {label}
                  <span>
                    <Landmark size={16} />
                  </span>
                </div>
                <div className="metric-value">{fmt(totals.contributed)}</div>
                <div className="metric-caption">Contributed in this period</div>
                {totals.withdrawn !== 0 && (
                  <p className="form-help">
                    {fmt(totals.withdrawn)} returned · {fmt(totals.net)} net
                  </p>
                )}
                <p className="form-help">
                  {fmt(totals.history_contributed)} contributed in imported
                  history through this month
                  {totals.history_withdrawn !== 0
                    ? ` · ${fmt(totals.history_withdrawn)} returned · ${fmt(totals.history_net)} net`
                    : ""}
                </p>
                <TextLink
                  onClick={() =>
                    ctx.navigate(
                      `/transactions?kind=${kind}&from=${data.from}&to=${periodEnd}&currency=${ctx.currency}`,
                    )
                  }
                >
                  View transfers
                </TextLink>
              </div>
            ))}
          </div>
          {data.months.length > 0 && (
            <div className="table-scroll">
              <table className="contribution-table">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th>Investments, net</th>
                    <th>Pension, net</th>
                  </tr>
                </thead>
                <tbody>
                  {data.months.map((point) => (
                    <tr key={point.month}>
                      <td>
                        <button
                          className="text-link"
                          onClick={() =>
                            ctx.navigate(
                              `/?month=${point.month}&currency=${ctx.currency}`,
                            )
                          }
                        >
                          {monthLabel(point.month)}
                        </button>
                      </td>
                      <td>{fmt(point.investment)}</td>
                      <td>{fmt(point.pension)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {!contributionKinds.length && (
        <section className="panel">
          <SectionTitle title="Contribution history" />
          <Empty
            title="No contributions recorded"
            text="Investment and pension transfers will appear here when imported or entered."
          />
        </section>
      )}
    </>
  );
}

function Metric({
  label,
  value,
  caption,
  icon,
  featured = false,
}: {
  label: string;
  value: string;
  caption: string;
  icon: React.ReactNode;
  featured?: boolean;
}) {
  return (
    <div className={`metric ${featured ? "featured" : ""}`}>
      <div className="metric-label">
        {label}
        <span>{icon}</span>
      </div>
      <div className="metric-value">{value}</div>
      <div className="metric-caption">{caption}</div>
    </div>
  );
}

function chartScale(values: number[]) {
  const min = Math.min(0, ...values),
    max = Math.max(0, ...values);
  const low = min < 0 ? min * 1.15 : 0;
  const high = max > 0 ? max * 1.15 : min < 0 ? 0 : 100;
  const y = (value: number) => 205 - ((value - low) / (high - low)) * 180;
  return {
    y,
    ticks: Array.from(
      { length: 5 },
      (_, index) => low + ((high - low) * index) / 4,
    ),
  };
}

function ChartAxes({
  scale,
  currency,
  width,
}: {
  scale: ReturnType<typeof chartScale>;
  currency: string;
  width: number;
}) {
  return (
    <g aria-hidden="true">
      {scale.ticks.map((tick, index) => (
        <g key={index}>
          <line
            x1="100"
            x2={width - 20}
            y1={scale.y(tick)}
            y2={scale.y(tick)}
            stroke="var(--line)"
          />
          <text
            x="90"
            y={scale.y(tick) + 4}
            textAnchor="end"
            className="analysis-axis"
          >
            {new Intl.NumberFormat("en-IE", {
              style: "currency",
              currency,
              notation: "compact",
              maximumFractionDigits: 1,
            }).format(tick / 10 ** currencyScale(currency))}
          </text>
        </g>
      ))}
      <line
        x1="100"
        x2={width - 20}
        y1={scale.y(0)}
        y2={scale.y(0)}
        stroke="var(--muted)"
        strokeOpacity="0.75"
        strokeDasharray="5 4"
        vectorEffect="non-scaling-stroke"
      />
    </g>
  );
}

function chartWidth(count: number) {
  return Math.max(650, 116 + count * 89);
}
function chartX(index: number, count: number) {
  return count === 1
    ? 365
    : 142 + index * ((chartWidth(count) - 205) / (count - 1));
}

function CashFlowChart({
  months,
  currency,
  selected,
  onSelect,
}: {
  months: MonthlyTotals[];
  currency: string;
  selected: string;
  onSelect: (month: string) => void;
}) {
  const [series, setSeries] = useState({
    spending: true,
    income: true,
    cumulativeNetCashFlow: true,
  });
  const clipId = useId();
  const points = cumulativeCashFlow(months);
  const width = chartWidth(points.length);
  const [hover, setHover] = useState("");
  const scale = chartScale(
    points.flatMap((point) => [
      series.spending ? point.spending : 0,
      series.income ? point.income : 0,
      series.cumulativeNetCashFlow ? point.cumulativeNetCashFlow : 0,
    ]),
  );
  const detail = points.find((point) => point.month === (hover || selected));
  const zeroY = scale.y(0);
  const cashLine = points
    .map(
      (point, index) =>
        `${chartX(index, points.length)},${scale.y(point.cumulativeNetCashFlow)}`,
    )
    .join(" ");
  const cashArea = points.length
    ? `${chartX(0, points.length)},${zeroY} ${cashLine} ${chartX(points.length - 1, points.length)},${zeroY}`
    : "";
  const toggle = (key: keyof typeof series) =>
    setSeries((value) =>
      value[key] &&
      !Object.entries(value).some(
        ([other, visible]) => other !== key && visible,
      )
        ? value
        : { ...value, [key]: !value[key] },
    );
  return (
    <div className="analysis-chart-body">
      <div className="analysis-series" aria-label="Visible chart series">
        {(["spending", "income", "cumulativeNetCashFlow"] as const).map(
          (key) => (
            <button
              key={key}
              aria-pressed={series[key]}
              onClick={() => toggle(key)}
            >
              <i
                style={{
                  background:
                    key === "spending"
                      ? "var(--green)"
                      : key === "income"
                        ? "#a7bca2"
                        : "linear-gradient(90deg, var(--green) 50%, #bf514b 50%)",
                  ...(key === "cumulativeNetCashFlow"
                    ? { width: 18, height: 3, borderRadius: 0 }
                    : {}),
                }}
              />
              {key === "spending"
                ? "Spending"
                : key === "income"
                  ? "Income"
                  : "Cumulative net cash flow"}
            </button>
          ),
        )}
      </div>
      {series.cumulativeNetCashFlow && (
        <div
          className="analysis-series"
          style={{ fontSize: 11, color: "var(--muted)" }}
        >
          <span>
            <i style={{ background: "var(--green)" }} /> Positive net cash
          </span>
          <span>
            <i style={{ background: "#bf514b" }} /> Negative net cash
          </span>
        </div>
      )}
      <svg
        className="analysis-chart"
        viewBox={`0 0 ${width} 250`}
        style={{
          minWidth: points.length > 6 ? chartWidth(points.length) : undefined,
        }}
        aria-label="Period spending, income and cumulative net cash flow chart"
      >
        <defs>
          <clipPath id={`${clipId}-positive`} clipPathUnits="userSpaceOnUse">
            <rect x="100" y="0" width={width - 120} height={zeroY} />
          </clipPath>
          <clipPath id={`${clipId}-negative`} clipPathUnits="userSpaceOnUse">
            <rect x="100" y={zeroY} width={width - 120} height={250 - zeroY} />
          </clipPath>
        </defs>
        {series.cumulativeNetCashFlow && (
          <g pointerEvents="none" aria-hidden="true">
            <polygon
              points={cashArea}
              fill="var(--green)"
              fillOpacity="0.09"
              clipPath={`url(#${clipId}-positive)`}
            />
            <polygon
              points={cashArea}
              fill="#bf514b"
              fillOpacity="0.09"
              clipPath={`url(#${clipId}-negative)`}
            />
          </g>
        )}
        <ChartAxes scale={scale} currency={currency} width={width} />
        {points.map((point, index) => {
          const x = chartX(index, points.length);
          const action = () => onSelect(point.month);
          return (
            <g
              key={point.month}
              role="button"
              tabIndex={0}
              className="analysis-mark"
              aria-label={`Explore ${monthLabel(point.month)}: spending ${formatMoney(point.spending, currency)}, income ${formatMoney(point.income, currency)}, cumulative net cash flow ${formatMoney(point.cumulativeNetCashFlow, currency)}`}
              aria-pressed={selected === point.month}
              onClick={action}
              onKeyDown={(event) => activate(event, action)}
              onMouseEnter={() => setHover(point.month)}
              onMouseLeave={() => setHover("")}
              onFocus={() => setHover(point.month)}
              onBlur={() => setHover("")}
            >
              <rect
                x={x - 40}
                y="18"
                width="80"
                height="220"
                rx="6"
                fill={
                  selected === point.month || hover === point.month
                    ? "var(--soft)"
                    : "transparent"
                }
              />
              {(["spending", "income"] as const)
                .filter((key) => series[key])
                .map((key, bar) => (
                  <rect
                    key={key}
                    x={
                      x +
                      (series.income && series.spending ? bar * 25 - 24 : -11)
                    }
                    y={Math.min(scale.y(point[key]), scale.y(0))}
                    width="22"
                    height={Math.abs(scale.y(point[key]) - scale.y(0))}
                    rx="3"
                    fill={key === "spending" ? "var(--green)" : "#a7bca2"}
                  />
                ))}
              <text x={x} y="232" textAnchor="middle" className="analysis-axis">
                {monthLabel(point.month, true)}
              </text>
            </g>
          );
        })}
        {series.cumulativeNetCashFlow && (
          <g pointerEvents="none">
            <g aria-label="Cumulative net cash flow line">
              {(["positive", "negative"] as const).map((sign) => (
                <polyline
                  key={sign}
                  fill="none"
                  stroke={sign === "positive" ? "var(--green)" : "#bf514b"}
                  strokeWidth="3"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  clipPath={`url(#${clipId}-${sign})`}
                  points={cashLine}
                />
              ))}
            </g>
            {points.map((point, index) => (
              <circle
                key={point.month}
                cx={chartX(index, points.length)}
                cy={scale.y(point.cumulativeNetCashFlow)}
                r={selected === point.month || hover === point.month ? 6 : 4}
                fill="var(--surface)"
                stroke={
                  point.cumulativeNetCashFlow < 0
                    ? "#bf514b"
                    : point.cumulativeNetCashFlow > 0
                      ? "var(--green)"
                      : "var(--muted)"
                }
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
        )}
      </svg>
      <div className="analysis-chart-detail" role="status">
        {detail ? (
          <>
            <strong>{monthLabel(detail.month)}</strong>
            <span>Spending {formatMoney(detail.spending, currency)}</span>
            <span>Income {formatMoney(detail.income, currency)}</span>
            <span
              style={{
                color:
                  detail.cumulativeNetCashFlow < 0
                    ? "#bf514b"
                    : detail.cumulativeNetCashFlow > 0
                      ? "var(--green)"
                      : "var(--muted)",
                fontWeight: 600,
              }}
            >
              Cumulative net cash flow{" "}
              {formatMoney(detail.cumulativeNetCashFlow, currency)}
            </span>
            <span>
              Net cash flow{" "}
              {formatMoney(
                detail.income -
                  detail.spending -
                  detail.investment -
                  detail.pension,
                currency,
              )}
            </span>
          </>
        ) : (
          <span>
            Hover or focus a month for exact totals. Select it to filter the
            breakdowns.
          </span>
        )}
      </div>
    </div>
  );
}

function CategoryTrend({
  points,
  currency,
  color,
  selected,
  onSelect,
}: {
  points: { month: string; amount: number }[];
  currency: string;
  color: string;
  selected: string;
  onSelect: (month: string) => void;
}) {
  const [hover, setHover] = useState("");
  const scale = chartScale(points.map((point) => point.amount));
  const detail = points.find((point) => point.month === (hover || selected));
  return (
    <div className="analysis-chart-body">
      <svg
        className="analysis-chart"
        viewBox={`0 0 ${chartWidth(points.length)} 250`}
        style={{
          minWidth: points.length > 6 ? chartWidth(points.length) : undefined,
        }}
        aria-label="Monthly category spending trend"
      >
        <ChartAxes
          scale={scale}
          currency={currency}
          width={chartWidth(points.length)}
        />
        <polyline
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeLinejoin="round"
          points={points
            .map(
              (point, index) =>
                `${chartX(index, points.length)},${scale.y(point.amount)}`,
            )
            .join(" ")}
        />
        {points.map((point, index) => {
          const x = chartX(index, points.length),
            action = () => onSelect(point.month);
          return (
            <g
              key={point.month}
              className="analysis-mark"
              role="button"
              tabIndex={0}
              aria-label={`Explore ${monthLabel(point.month)}: ${formatMoney(point.amount, currency)} net spending`}
              aria-pressed={selected === point.month}
              onClick={action}
              onKeyDown={(event) => activate(event, action)}
              onMouseEnter={() => setHover(point.month)}
              onMouseLeave={() => setHover("")}
              onFocus={() => setHover(point.month)}
              onBlur={() => setHover("")}
            >
              <rect
                x={x - 35}
                y="15"
                width="70"
                height="225"
                fill="transparent"
              />
              <circle
                cx={x}
                cy={scale.y(point.amount)}
                r={selected === point.month || hover === point.month ? 8 : 5}
                fill={color}
                stroke="var(--surface)"
                strokeWidth="2"
              />
              <text x={x} y="232" textAnchor="middle" className="analysis-axis">
                {monthLabel(point.month, true)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="analysis-chart-detail" role="status">
        {detail ? (
          <>
            <strong>{monthLabel(detail.month)}</strong>
            <span>Net spending {formatMoney(detail.amount, currency)}</span>
          </>
        ) : (
          <span>
            Hover or focus a point for exact spending. Select a point to explore
            that month.
          </span>
        )}
      </div>
    </div>
  );
}
