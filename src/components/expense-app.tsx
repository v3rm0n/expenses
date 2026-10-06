"use client";
import { useDialogFocus } from "../hooks/use-dialog-focus";
import { ISODateInput } from "./iso-date-input";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowUpRight,
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
  updateQuery,
  useData,
  Loading,
  ErrorMessage,
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
} from "./records";
import { PeriodOverview } from "./overview";
import { ReviewView } from "./review";
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
  const requestedMonths = Number(search.get("months") || 1);
  const [periodMonths, setPeriodMonths] = useState(
    Number.isInteger(requestedMonths) &&
      requestedMonths >= 1 &&
      requestedMonths <= 12
      ? requestedMonths
      : 1,
  );
  const [authenticated, setAuthenticated] = useState(false),
    [checking, setChecking] = useState(true),
    [needsSetup, setNeedsSetup] = useState(false);
  const [revision, setRevision] = useState(0),
    [month, setMonth] = useState(currentMonth),
    [currency, setCurrency] = useState("EUR"),
    [mobile, setMobile] = useState(false),
    [toast, setToast] = useState("");
  const sidebar = useRef<HTMLElement>(null);
  useDialogFocus(sidebar, () => setMobile(false), mobile);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 781px)");
    const closeOnDesktop = () => {
      if (desktop.matches) setMobile(false);
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);
  const refresh = () => setRevision((value) => value + 1),
    navigate = (path: string) => {
      setMobile(false);
      const target = new URL(path, window.location.origin);
      if (["/", "/six-month", "/transactions"].includes(target.pathname)) {
        if (!target.searchParams.has("month"))
          target.searchParams.set("month", month);
        if (!target.searchParams.has("currency"))
          target.searchParams.set("currency", currency);
      }
      if (target.pathname === "/" && !target.searchParams.has("months"))
        target.searchParams.set("months", String(periodMonths));
      router.push(`${target.pathname}${target.search}`);
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
      setMobile(false);
      setAuthenticated(false);
      router.replace("/login");
    };
    window.addEventListener("expenses:unauthorized", fn);
    return () => window.removeEventListener("expenses:unauthorized", fn);
  }, [router]);
  useEffect(() => {
    const saved = window.localStorage.getItem("expenses_currency");
    if (saved && /^[A-Z]{3}$/.test(saved)) setCurrency(saved);
    const period = Number(
      window.localStorage.getItem("expenses_period_months"),
    );
    if (
      !search.has("months") &&
      Number.isInteger(period) &&
      period >= 1 &&
      period <= 12
    )
      setPeriodMonths(period);
  }, []);
  useEffect(() => {
    window.localStorage.setItem("expenses_currency", currency);
  }, [currency]);
  useEffect(() => {
    if (search.get("month") && /^\d{4}-\d{2}$/.test(search.get("month")!))
      setMonth(search.get("month")!);
    if (search.get("currency") && /^[A-Z]{3}$/.test(search.get("currency")!))
      setCurrency(search.get("currency")!);
    const period = Number(search.get("months"));
    if (
      search.has("months") &&
      Number.isInteger(period) &&
      period >= 1 &&
      period <= 12
    ) {
      setPeriodMonths(period);
      window.localStorage.setItem("expenses_period_months", String(period));
    }
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
  function selectMonth(value: string) {
    setMonth(value);
    updateQuery({ month: value, from: "", to: "" }, true);
  }
  function selectCurrency(value: string) {
    setCurrency(value);
    updateQuery({ currency: value }, true);
  }
  const context: AppContext = {
    state: state.data,
    currency,
    month,
    revision,
    refresh,
    navigate,
    notify: setToast,
    setMonth: selectMonth,
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
    selectMonth(d.toISOString().slice(0, 7));
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
      <aside
        ref={sidebar}
        id="application-navigation"
        className={`sidebar ${mobile ? "open" : ""}`}
        role={mobile ? "dialog" : undefined}
        aria-modal={mobile || undefined}
        aria-label="Navigation"
        tabIndex={-1}
      >
        <Brand />
        <button
          className="sidebar-close icon-button"
          onClick={() => setMobile(false)}
          aria-label="Close menu"
        >
          <X />
        </button>
        <nav>
          {navigation.map((item) => (
            <button
              key={item.path}
              className={`nav-item ${(item.path === "/" ? active === "overview" : pathname.startsWith(item.path)) ? "active" : ""} ${item.path === "/connections" ? "nav-separated" : ""}`}
              aria-current={
                (
                  item.path === "/"
                    ? active === "overview"
                    : pathname.startsWith(item.path)
                )
                  ? "page"
                  : undefined
              }
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
                setMobile(false);
                setAuthenticated(false);
                router.push("/login");
              }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-wrap" inert={mobile}>
        <main>
          <div className="page-heading">
            <div className="page-title">
              <button
                className="mobile-menu icon-button"
                aria-label="Open navigation"
                aria-expanded={mobile}
                aria-controls="application-navigation"
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
            {path.length <= 1 &&
              ["overview", "transactions"].includes(active) && (
                <div className="page-controls">
                  {active === "overview" && (
                    <select
                      aria-label="Period length"
                      value={periodMonths}
                      onChange={(e) => {
                        setPeriodMonths(Number(e.target.value));
                        window.localStorage.setItem(
                          "expenses_period_months",
                          e.target.value,
                        );
                        updateQuery({ months: e.target.value });
                      }}
                    >
                      {Array.from({ length: 12 }, (_, i) => i + 1).map(
                        (count) => (
                          <option key={count} value={count}>
                            {count === 1
                              ? "1 month"
                              : count === 12
                                ? "1 year"
                                : `${count} months`}
                          </option>
                        ),
                      )}
                    </select>
                  )}
                  <select
                    aria-label="Currency"
                    className="currency-select"
                    value={currency}
                    onChange={(e) => selectCurrency(e.target.value)}
                  >
                    {[...new Set([...state.data.currencies, currency])].map(
                      (c) => (
                        <option key={c}>{c}</option>
                      ),
                    )}
                  </select>
                  {search.get("history") !== "true" && (
                    <div className="month-picker">
                      <button
                        aria-label="Previous month"
                        onClick={() => shiftMonth(-1)}
                      >
                        <ChevronLeft size={16} />
                      </button>
                      <ISODateInput
                        precision="month"
                        aria-label={
                          active === "overview" ? "Period ending" : "Month"
                        }
                        value={month}
                        onChange={(e) =>
                          e.target.value && selectMonth(e.target.value)
                        }
                      />
                      <button
                        aria-label="Next month"
                        onClick={() => shiftMonth(1)}
                      >
                        <ChevronRight size={16} />
                      </button>
                    </div>
                  )}
                </div>
              )}
          </div>
          <ErrorMessage message={state.error} />
          {active === "overview" && (
            <div className="view-stack">
              <PeriodOverview
                key={`${month}-${currency}-${periodMonths}`}
                context={context}
                months={periodMonths}
              />
              <OverviewDetails
                key={`details-${month}-${currency}-${periodMonths}`}
                context={context}
                months={periodMonths}
              />
            </div>
          )}
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
      <nav
        className={`mobile-nav ${mobile ? "drawer-open" : ""}`}
        aria-label="Mobile navigation"
        aria-hidden={mobile || undefined}
      >
        {navigation.slice(0, 4).map((item) => {
          const selected =
            item.path === "/"
              ? active === "overview"
              : pathname.startsWith(item.path);
          return (
            <button
              key={item.path}
              className={selected ? "active" : ""}
              aria-current={selected ? "page" : undefined}
              onClick={() => navigate(item.path)}
            >
              <span className="mobile-nav-icon">
                <item.icon size={21} />
                {item.path === "/review" && reviewCount > 0 && (
                  <span className="mobile-nav-badge" aria-hidden="true">
                    {reviewCount > 99 ? "99+" : reviewCount}
                  </span>
                )}
              </span>
              <span>{item.label}</span>
            </button>
          );
        })}
        <button
          className={
            ["connections", "rules", "settings"].includes(active)
              ? "active"
              : ""
          }
          aria-expanded={mobile}
          aria-controls="application-navigation"
          onClick={() => setMobile(true)}
        >
          <Menu size={21} />
          <span>More</span>
        </button>
      </nav>
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
type Summary = {
  from: string;
  to: string;
  spending: number;
  gross_spending: number;
  refunds: number;
  income: number;
  net_cash_flow: number;
  transactions: number;
  expense_count: number;
  receipt_count: number;
  receipt_required_count: number;
  receipt_excluded_count: number;
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
};
function OverviewDetails({
  context: ctx,
  months,
}: {
  context: AppContext;
  months: number;
}) {
  const { data, error, loading } = useData<Summary>(
    `overview?month=${ctx.month}&currency=${ctx.currency}&months=${months}`,
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
    coverage = data.receipt_required_count
      ? Math.round((data.receipt_count / data.receipt_required_count) * 100)
      : 0;
  const periodEnd = new Date(
    new Date(`${data.to}T12:00:00Z`).getTime() - 86400000,
  )
    .toISOString()
    .slice(0, 10);
  const periodTransactions = `/transactions?from=${data.from}&to=${periodEnd}&currency=${ctx.currency}`;
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
      <div className="overview-grid lower">
        <div className="metric">
          <div className="metric-label">
            RECEIPT COVERAGE
            <span>
              <ReceiptText size={16} />
            </span>
          </div>
          <div className="metric-value">
            {data.receipt_required_count ? coverage : "—"}
            {data.receipt_required_count > 0 && (
              <span className="metric-unit">%</span>
            )}
          </div>
          <div className="metric-caption">
            {data.receipt_required_count
              ? `${data.receipt_count} of ${data.receipt_required_count} payments linked`
              : "No receipts required"}
            {data.receipt_excluded_count > 0 && (
              <div>
                {data.receipt_excluded_count}{" "}
                {data.receipt_excluded_count === 1 ? "payment" : "payments"}{" "}
                excluded
              </div>
            )}
          </div>
          <div className="progress">
            <i style={{ width: `${coverage}%` }} />
          </div>
        </div>
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
            <TextLink onClick={() => ctx.navigate(periodTransactions)}>
              All transactions
            </TextLink>
          }
        />
        {data.recent.length ? (
          <EntryTable entries={data.recent} navigate={ctx.navigate} />
        ) : (
          <Empty
            title="No transactions in this period"
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
    </div>
  );
}
