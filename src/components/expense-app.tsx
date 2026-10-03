"use client";
import { useEffect, useState, type FormEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowUpRight,
  ArrowDownLeft,
  BarChart3,
  WalletCards,
  ReceiptText,
  ListFilter,
  Landmark,
  Settings2,
  LogOut,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
  Menu,
  X,
  Plus,
  Upload,
  CheckCheck,
  CircleHelp,
} from "lucide-react";
import {
  api,
  useData,
  Loading,
  ErrorMessage,
  Badge,
  Empty,
  SectionTitle,
  TextLink,
  EntryTable,
  initials,
  type AppContext,
  type AppState,
  type Entry,
} from "./ui";
import { formatMoney } from "../lib/money";
import {
  TransactionsView,
  TransactionDetailView,
  ReceiptsView,
  ReceiptDetailView,
  ReviewView,
} from "./records";
import { ConnectionsView, RulesView, SettingsView } from "./settings";

const currentMonth = () =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Tallinn",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
const navigation = [
  { path: "/", label: "Overview", icon: BarChart3 },
  { path: "/transactions", label: "Transactions", icon: WalletCards },
  { path: "/receipts", label: "Receipts", icon: ReceiptText },
  { path: "/review", label: "Review", icon: ListFilter },
  { path: "/connections", label: "Connections", icon: Landmark },
  { path: "/rules", label: "Rules", icon: SlidersHorizontal },
  { path: "/settings", label: "Settings", icon: Settings2 },
];
export default function ExpenseApp() {
  const router = useRouter(),
    pathname = usePathname(),
    search = useSearchParams();
  const [authenticated, setAuthenticated] = useState(false),
    [checking, setChecking] = useState(true),
    [needsSetup, setNeedsSetup] = useState(false);
  const [revision, setRevision] = useState(0),
    [month, setMonth] = useState(currentMonth),
    [currency, setCurrency] = useState("EUR"),
    [mobile, setMobile] = useState(false),
    [toast, setToast] = useState("");
  const refresh = () => setRevision((value) => value + 1),
    navigate = (path: string) => {
      setMobile(false);
      router.push(path);
    };
  useEffect(() => {
    api<{ authenticated: boolean; needsSetup: boolean }>("auth/status")
      .then((status) => {
        setAuthenticated(status.authenticated);
        setNeedsSetup(status.needsSetup);
        setChecking(false);
      })
      .catch(() => setChecking(false));
    const fn = () => {
      setAuthenticated(false);
      router.replace("/login");
    };
    window.addEventListener("expenses:unauthorized", fn);
    return () => window.removeEventListener("expenses:unauthorized", fn);
  }, [router]);
  useEffect(() => {
    const saved = window.localStorage.getItem("expenses_currency");
    if (saved && /^[A-Z]{3}$/.test(saved)) setCurrency(saved);
  }, []);
  useEffect(() => {
    window.localStorage.setItem("expenses_currency", currency);
  }, [currency]);
  useEffect(() => {
    if (search.get("month") && /^\d{4}-\d{2}$/.test(search.get("month")!))
      setMonth(search.get("month")!);
    if (search.get("currency") && /^[A-Z]{3}$/.test(search.get("currency")!))
      setCurrency(search.get("currency")!);
  }, [search]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (authenticated && ["/login", "/setup"].includes(pathname))
      router.replace("/");
  }, [authenticated, pathname, router]);
  const state = useData<AppState>(
    authenticated ? "state" : null,
    revision,
    30000,
  );
  if (checking)
    return (
      <div className="boot">
        <Brand />
        <Loading />
      </div>
    );
  if (!authenticated)
    return (
      <AuthScreen
        setup={needsSetup}
        onDone={() => {
          setAuthenticated(true);
          setNeedsSetup(false);
          refresh();
          router.replace("/");
        }}
      />
    );
  if (!state.data)
    return (
      <div className="boot">
        <Brand />
        <ErrorMessage message={state.error} />
        {state.loading && <Loading />}
      </div>
    );
  const context: AppContext = {
    state: state.data,
    currency,
    month,
    revision,
    refresh,
    navigate,
    notify: setToast,
    setMonth,
  };
  const path = pathname.split("/").filter(Boolean),
    active = path[0] || "overview";
  const title =
    navigation.find((item) => item.path === `/${path[0] || ""}`)?.label ||
    "Overview";
  const reviewCount = Object.values(state.data.review).reduce(
    (a, b) => a + b,
    0,
  );
  const shiftMonth = (by: number) => {
    const d = new Date(`${month}-01T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + by);
    setMonth(d.toISOString().slice(0, 7));
  };
  return (
    <div className="app-layout">
      {mobile && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <aside className={`sidebar ${mobile ? "open" : ""}`}>
        <Brand />
        <button
          className="sidebar-close icon-button"
          onClick={() => setMobile(false)}
          aria-label="Close menu"
        >
          <X />
        </button>
        <nav>
          {navigation.map((item, i) => (
            <button
              key={item.path}
              className={`nav-item ${(item.path === "/" ? active === "overview" : pathname.startsWith(item.path)) ? "active" : ""} ${i === 4 ? "nav-separated" : ""}`}
              onClick={() => navigate(item.path)}
            >
              <item.icon size={19} />
              <span>{item.label}</span>
              {item.path === "/review" && reviewCount > 0 && (
                <span className="nav-count">{reviewCount}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="owner">
            <span className="owner-avatar">{initials(state.data.owner)}</span>
            <span>
              <strong>{state.data.owner}</strong>
            </span>
            <button
              className="icon-button"
              aria-label="Sign out"
              onClick={async () => {
                await api("auth/logout", {});
                setAuthenticated(false);
                router.push("/login");
              }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-wrap">
        <main>
          <div className="page-heading">
            <div className="page-title">
              <button
                className="mobile-menu icon-button"
                aria-label="Open navigation"
                onClick={() => setMobile(true)}
              >
                <Menu size={21} />
              </button>
              <h1>
                {path.length > 1
                  ? active === "receipts"
                    ? "Receipt details"
                    : "Transaction details"
                  : title}
              </h1>
            </div>
            <div className="page-controls">
              <select
                aria-label="Currency"
                className="currency-select"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {[...new Set([...state.data.currencies, currency])].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
              {["overview", "transactions"].includes(active) && (
                <div className="month-picker">
                  <button
                    aria-label="Previous month"
                    onClick={() => shiftMonth(-1)}
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <input
                    type="month"
                    aria-label="Month"
                    value={month}
                    onChange={(e) => e.target.value && setMonth(e.target.value)}
                  />
                  <button aria-label="Next month" onClick={() => shiftMonth(1)}>
                    <ChevronRight size={16} />
                  </button>
                </div>
              )}
            </div>
          </div>
          <ErrorMessage message={state.error} />
          {active === "overview" && <OverviewView context={context} />}
          {active === "transactions" &&
            (path[1] ? (
              <TransactionDetailView context={context} id={path[1]} />
            ) : (
              <TransactionsView context={context} />
            ))}
          {active === "receipts" &&
            (path[1] ? (
              <ReceiptDetailView context={context} id={path[1]} />
            ) : (
              <ReceiptsView context={context} />
            ))}
          {active === "review" && <ReviewView context={context} />}
          {active === "connections" && <ConnectionsView context={context} />}
          {active === "rules" && <RulesView context={context} />}
          {active === "settings" && <SettingsView context={context} />}
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CheckCheck size={18} />
          {toast}
        </div>
      )}
    </div>
  );
}
function Brand() {
  return (
    <div className="brand">
      <span>
        <WalletCards size={24} strokeWidth={1.7} />
      </span>
      <strong>
        expenses<span className="brand-period">.</span>
      </strong>
    </div>
  );
}
function AuthScreen({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const search = useSearchParams();
  const [token, setToken] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [name, setName] = useState(""),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const value = search.get("token");
    if (value) {
      setToken(value);
      window.history.replaceState(null, "", "/setup");
    }
  }, [search]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (setup && password !== confirm) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await api(
        setup ? "auth/setup" : "auth/login",
        setup ? { name, password, token } : { password },
      );
      onDone();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-page">
      <div className="auth-form-wrap">
        <div className="auth-brand">
          <Brand />
        </div>
        <form onSubmit={submit} className="auth-form">
          <h1>{setup ? "Create account" : "Sign in"}</h1>
          <ErrorMessage message={error} />
          {setup && !token && (
            <div className="notice">
              <CircleHelp size={18} />
              <span>
                Run <code>npm run setup</code> in the project folder and open
                the setup link it prints.
              </span>
            </div>
          )}
          {setup && (
            <label>
              Your name
              <input
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={80}
                placeholder="Your name"
              />
            </label>
          )}
          <label>
            Password
            <input
              type="password"
              autoComplete={setup ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={setup ? 12 : undefined}
              maxLength={256}
              placeholder={
                setup ? "At least 12 characters" : "Enter your password"
              }
            />
          </label>
          {setup && (
            <label>
              Confirm password
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={12}
              />
            </label>
          )}
          <button
            className="button primary wide"
            disabled={busy || (setup && !token)}
          >
            {busy ? "Submitting…" : setup ? "Create account" : "Sign in"}
            <ArrowUpRight size={17} />
          </button>
        </form>
      </div>
    </div>
  );
}
type Contributions = {
  contributed: number;
  withdrawn: number;
  net: number;
  history_contributed: number;
  history_withdrawn: number;
  history_net: number;
};
type Summary = {
  investment: Contributions;
  pension: Contributions;
  spending: number;
  gross_spending: number;
  refunds: number;
  income: number;
  net_cash_flow: number;
  transactions: number;
  expense_count: number;
  receipt_count: number;
  uncategorized: { amount: number; count: number };
  categories: Array<{
    id: string;
    name: string;
    color: string;
    amount: number;
    count: number;
  }>;
  merchants: Array<{ merchant: string; amount: number; count: number }>;
  trend: Array<{
    month: string;
    spending: number;
    income: number;
    investment: number;
    pension: number;
  }>;
  recent: Entry[];
  pending: { count: number; amount: number };
  cash: { amount: number };
  recurring: Array<{
    merchant: string;
    currency: string;
    amount: number;
    months: number;
    confirmed: boolean;
  }>;
};
function OverviewView({ context: ctx }: { context: AppContext }) {
  const { data, error, loading } = useData<Summary>(
    `overview?month=${ctx.month}&currency=${ctx.currency}`,
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
  const fmt = (value: number) => formatMoney(value, ctx.currency),
    coverage = data.expense_count
      ? Math.round((data.receipt_count / data.expense_count) * 100)
      : 0;
  const positive = data.categories.filter((c) => c.amount > 0),
    categoryTotal = positive.reduce((sum, c) => sum + c.amount, 0);
  let start = 0;
  const segments = positive.map((category) => {
    const span = (category.amount / categoryTotal) * 100,
      segment = { ...category, start, span };
    start += span;
    return segment;
  });
  const previous = data.trend.at(-2)?.spending || 0,
    difference = data.spending - previous;
  return (
    <div className="view-stack">
      <ErrorMessage message={error} />
      {!ctx.state.accounts.some((a) => a.source === "bank") && (
        <div className="welcome-banner">
          <div className="welcome-icon">
            <Landmark size={25} />
          </div>
          <div>
            <strong>No bank connected</strong>
            <p>Connect a bank to import transactions.</p>
          </div>
          <button
            className="button primary"
            onClick={() => ctx.navigate("/connections")}
          >
            Connect a bank
            <ArrowUpRight size={16} />
          </button>
        </div>
      )}
      <div className="metric-grid">
        <div className="metric featured">
          <div className="metric-label">
            NET SPENDING
            <span>
              <ArrowUpRight size={16} />
            </span>
          </div>
          <div className="metric-value">{fmt(data.spending)}</div>
          <div className="metric-caption">
            {data.refunds
              ? `${fmt(data.refunds)} in refunds included`
              : previous
                ? `${difference <= 0 ? "Down" : "Up"} ${fmt(Math.abs(difference))} from last month`
                : "Booked expenses this month"}
          </div>
          <div className="metric-decoration" />
        </div>
        <div className="metric">
          <div className="metric-label">
            INCOME
            <span>
              <ArrowDownLeft size={16} />
            </span>
          </div>
          <div className="metric-value">{fmt(data.income)}</div>
          <div className="metric-caption">
            Incoming payments, excluding transfers
          </div>
        </div>
        <div className="metric">
          <div className="metric-label">
            NET CASH FLOW
            <span>
              <WalletCards size={16} />
            </span>
          </div>
          <div
            className={`metric-value ${data.net_cash_flow < 0 ? "negative" : ""}`}
          >
            {fmt(data.net_cash_flow)}
          </div>
          <div className="metric-caption">
            After spending, refunds and contributions
          </div>
        </div>
        <div className="metric">
          <div className="metric-label">
            RECEIPT COVERAGE
            <span>
              <ReceiptText size={16} />
            </span>
          </div>
          <div className="metric-value">
            {coverage}
            <span className="metric-unit">%</span>
          </div>
          <div className="metric-caption">
            {data.receipt_count} of {data.expense_count} payments linked
          </div>
          <div className="progress">
            <i style={{ width: `${coverage}%` }} />
          </div>
        </div>
      </div>
      <section className="panel contributions-panel">
        <SectionTitle title="Investments and pensions" />
        <div className="metric-grid contribution-grid">
          {(
            [
              {
                kind: "investment",
                label: "INVESTMENT TRANSFERS",
                totals: data.investment,
              },
              {
                kind: "pension",
                label: "PENSION CONTRIBUTIONS",
                totals: data.pension,
              },
            ] as const
          ).map(({ kind, label, totals }) => (
            <div className="metric" key={kind}>
              <div className="metric-label">
                {label}
                <span>
                  <Landmark size={16} />
                </span>
              </div>
              <div className="metric-value">{fmt(totals.contributed)}</div>
              <div className="metric-caption">Contributed this month</div>
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
                    `/transactions?kind=${kind}&month=${ctx.month}&currency=${ctx.currency}`,
                  )
                }
              >
                View transfers
              </TextLink>
            </div>
          ))}
        </div>
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
              {data.trend.map((point) => (
                <tr key={point.month}>
                  <td>
                    <button
                      className="text-link"
                      onClick={() => ctx.setMonth(point.month)}
                    >
                      {point.month}
                    </button>
                  </td>
                  <td>{fmt(point.investment)}</td>
                  <td>{fmt(point.pension)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <div className="overview-grid">
        <section className="panel category-panel">
          <SectionTitle
            title="Spending by category"
            action={
              <TextLink onClick={() => ctx.navigate("/transactions")}>
                View transactions
              </TextLink>
            }
          />
          {categoryTotal ? (
            <>
              <div className="donut-wrap">
                <svg
                  viewBox="0 0 200 200"
                  role="img"
                  aria-label="Spending by category"
                >
                  <circle
                    cx="100"
                    cy="100"
                    r="76"
                    fill="none"
                    stroke="#ecefea"
                    strokeWidth="22"
                  />
                  {segments.map((segment) => (
                    <circle
                      key={segment.id}
                      cx="100"
                      cy="100"
                      r="76"
                      fill="none"
                      stroke={segment.color}
                      strokeWidth="22"
                      pathLength="100"
                      strokeDasharray={`${Math.max(0, segment.span - 0.8)} ${100 - Math.max(0, segment.span - 0.8)}`}
                      strokeDashoffset={-segment.start}
                      transform="rotate(-90 100 100)"
                    />
                  ))}
                </svg>
                <div className="donut-center">
                  <span>THIS MONTH</span>
                  <strong>{fmt(data.spending)}</strong>
                  <small>{data.transactions} transactions</small>
                </div>
              </div>
              <div className="category-legend">
                {data.categories.map((category) => (
                  <button
                    key={category.id}
                    onClick={() =>
                      ctx.navigate(`/transactions?category=${category.id}`)
                    }
                  >
                    <span>
                      <i style={{ background: category.color }} />
                      {category.name}
                    </span>
                    <strong>{fmt(category.amount)}</strong>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <Empty
              title="No spending this month"
              text="Import transactions or add a cash expense to see spending by category."
            />
          )}
        </section>
        <section className="panel trend-panel">
          <SectionTitle
            title="Spending and income"
            description="Last six months"
            action={<Badge>{ctx.currency}</Badge>}
          />
          {data.trend.some((point) => point.spending || point.income) ? (
            <div className="trend-chart">
              {data.trend.map((point) => {
                const max = Math.max(
                  ...data.trend.map((p) =>
                    Math.max(Math.abs(p.spending), Math.abs(p.income)),
                  ),
                  1,
                );
                return (
                  <button
                    key={point.month}
                    className={`trend-column ${point.month === ctx.month ? "selected" : ""}`}
                    onClick={() => ctx.setMonth(point.month)}
                  >
                    <strong>{fmt(point.spending)}</strong>
                    <div className="bar-space">
                      <i
                        style={{
                          height: `${Math.max(2, (Math.abs(point.spending) / max) * 150)}px`,
                        }}
                      />
                      <i
                        className="income-bar"
                        style={{
                          height: `${Math.max(2, (Math.abs(point.income) / max) * 150)}px`,
                        }}
                      />
                    </div>
                    <span>
                      {new Intl.DateTimeFormat("en", { month: "short" }).format(
                        new Date(`${point.month}-15`),
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <Empty
              title="No transactions in the last six months"
              text="Connect a bank or add a cash entry to see monthly totals."
            />
          )}
          <div className="chart-key">
            <span>
              <i />
              Spending
            </span>
            <span>
              <i className="income-key" />
              Income
            </span>
          </div>
          <div className="insight-strip">
            <p>
              {data.uncategorized.count
                ? `${data.uncategorized.count} payments still need a category. They’re included in your spending total.`
                : "Transfers are excluded from spending. Each currency has its own overview."}
            </p>
          </div>
        </section>
      </div>
      <div className="overview-grid lower">
        <section className="panel">
          <SectionTitle title="Top merchants" />
          {data.merchants.length ? (
            <div className="merchant-list">
              {data.merchants.map((merchant, i) => (
                <button
                  key={merchant.merchant}
                  onClick={() =>
                    ctx.navigate(
                      `/transactions?search=${encodeURIComponent(merchant.merchant)}`,
                    )
                  }
                >
                  <span className="merchant-rank">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <strong>{merchant.merchant}</strong>
                    <small>{merchant.count} payments</small>
                  </div>
                  <strong>{fmt(merchant.amount)}</strong>
                </button>
              ))}
            </div>
          ) : (
            <Empty
              title="No payments this month"
              text="Try another month or connect your first bank account."
            />
          )}
        </section>
        <section className="panel attention-panel">
          <SectionTitle title="Needs review" />
          <div className="attention-list">
            <button onClick={() => ctx.navigate("/review")}>
              <span className="attention-icon">
                <ListFilter size={19} />
              </span>
              <div>
                <strong>
                  {data.uncategorized.count} payments to categorize
                </strong>
                <small>
                  {fmt(data.uncategorized.amount)} still awaiting a category
                </small>
              </div>
              <ChevronRight size={17} />
            </button>
            <button onClick={() => ctx.navigate("/receipts")}>
              <span className="attention-icon">
                <ReceiptText size={19} />
              </span>
              <div>
                <strong>{ctx.state.review.receipts} receipts to review</strong>
                <small>Check products and connect payments</small>
              </div>
              <ChevronRight size={17} />
            </button>
            <button onClick={() => ctx.navigate("/transactions?status=PDNG")}>
              <span className="attention-icon">
                <WalletCards size={19} />
              </span>
              <div>
                <strong>{data.pending.count} pending payments</strong>
                <small>{fmt(data.pending.amount)} excluded until booked</small>
              </div>
              <ChevronRight size={17} />
            </button>
            {data.cash.amount > 0 && (
              <div className="notice">
                {fmt(data.cash.amount)} in cash withdrawals remains unallocated.
                Record cash purchases to allocate it.
              </div>
            )}
          </div>
        </section>
      </div>
      <section className="panel">
        <SectionTitle
          title="Recent transactions"
          action={
            <TextLink onClick={() => ctx.navigate("/transactions")}>
              All transactions
            </TextLink>
          }
        />
        {data.recent.length ? (
          <EntryTable entries={data.recent} navigate={ctx.navigate} />
        ) : (
          <Empty
            title="No transactions this month"
            text="Connect a bank or record a cash expense to get started."
          >
            <button
              className="button secondary"
              onClick={() => ctx.navigate("/transactions?new=true")}
            >
              <Plus size={16} />
              Add cash expense
            </button>
          </Empty>
        )}
      </section>
      {data.recurring.length > 0 && (
        <section className="panel">
          <SectionTitle
            title="Recurring payments"
            description="Similar payments in at least three months. Confirm the ones that recur."
          />
          <div className="recurring-grid">
            {data.recurring.map((item) => (
              <div className="recurring-card" key={item.merchant}>
                <strong>{item.merchant}</strong>
                <span>{fmt(item.amount)} / payment</span>
                <button
                  className="text-link"
                  onClick={async () => {
                    await api("recurring", {
                      merchant: item.merchant,
                      currency: ctx.currency,
                      confirmed: !item.confirmed,
                    });
                    ctx.refresh();
                  }}
                >
                  {item.confirmed ? "Confirmed · Undo" : "Confirm recurring"}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
