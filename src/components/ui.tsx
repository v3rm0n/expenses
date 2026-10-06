"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, LoaderCircle, Inbox } from "lucide-react";
export function updateQuery(
  values: Record<string, string | null>,
  resetPage = false,
) {
  const url = new URL(window.location.href);
  if (resetPage) url.searchParams.delete("page");
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}
export async function api<T = unknown>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers:
      body instanceof FormData || body === undefined
        ? {}
        : { "Content-Type": "application/json" },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("auth/"))
      window.dispatchEvent(new Event("expenses:unauthorized"));
    throw new Error(data.error || "Something went wrong. Please retry.");
  }
  return data as T;
}
export function useData<T>(path: string | null, revision = 0, poll = 0) {
  const [data, setData] = useState<T>(),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(true);
  const previous = useRef(path);
  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    if (previous.current !== path) {
      setData(undefined);
      previous.current = path;
    }
    const load = async () => {
      setLoading(true);
      try {
        const value = await api<T>(path);
        if (!cancelled) {
          setData(value);
          setError(null);
        }
      } catch (e) {
        if (!cancelled)
          setError(
            e instanceof Error ? e.message : "Could not load this view.",
          );
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = poll ? window.setInterval(load, poll) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [path, revision, poll]);
  return { data, error, loading };
}
export function Loading() {
  return (
    <div className="loading">
      <LoaderCircle size={22} className="spin" />
      <span>Loading your expenses…</span>
    </div>
  );
}
export function ErrorMessage({ message }: { message: string | null }) {
  return message ? (
    <div className="notice error" role="alert">
      {message}
    </div>
  ) : null;
}
export function Empty({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Inbox size={25} strokeWidth={1.6} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {children && <div className="empty-actions">{children}</div>}
    </div>
  );
}
export function Badge({
  children,
  variant = "neutral",
}: {
  children: ReactNode;
  variant?: string;
}) {
  return <span className={`badge ${variant}`}>{children}</span>;
}
export function SectionTitle({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  );
}
export function TextLink({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className="text-link" onClick={onClick}>
      {children}
      <ArrowRight size={15} />
    </button>
  );
}
export { shortDate, dateTime } from "../lib/dates";
import { shortDate } from "../lib/dates";
export function initials(name: string) {
  return name
    .split(/[\s/]+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}
export type Category = { id: string; name: string; color: string };
export type Account = {
  id: string;
  name: string;
  nickname: string | null;
  source: string;
  bank_name?: string;
  currency: string | null;
  iban: string | null;
  history_from: string | null;
  history_to: string | null;
  last_sync_at: string | null;
  balance?: {
    balances?: Array<{
      balance_amount: { amount: string; currency: string };
      balance_type: string;
    }>;
  };
};
export type Entry = {
  id: string;
  account_id: string;
  account_name: string;
  source: string;
  merchant: string;
  merchant_group?: string;
  description: string;
  amount: number;
  currency: string;
  kind: string;
  status: string;
  booked_at: string | null;
  manual: boolean;
  note: string;
  receipt_count?: number;
  receipt_not_required: boolean;
  allocations: Array<{
    category_id: string;
    amount: number;
    name: string;
    color?: string;
    source: string;
  }>;
  receipts?: Array<{
    id: string;
    filename: string;
    merchant: string;
    total: number;
    currency: string;
    linked_amount: number;
    status: string;
  }>;
  raw?: unknown;
};
export type Receipt = {
  id: string;
  filename: string;
  retailer: string;
  merchant: string | null;
  purchased_at: string | null;
  currency: string;
  total: number | null;
  receipt_number: string | null;
  status: string;
  issues: string[];
  error: string | null;
  source: string;
  linked_amount: number;
  item_count: number;
  manual: boolean;
  created_at: string;
  updated_at: string;
  content_type: string;
  text: string;
};
export type ReceiptDetail = Receipt & {
  suggested_categories: Category[];
  items: Array<{
    id: string;
    description: string;
    quantity: string | null;
    unit: string | null;
    amount: number;
    category_id: string;
  }>;
  links: Array<{
    transaction_id: string;
    amount: number;
    merchant: string;
    description: string;
    status: string;
    booked_at: string | null;
    account_name: string;
    source: string;
  }>;
  candidates: Array<{
    id: string;
    merchant: string;
    description: string;
    status: string;
    booked_at: string | null;
    amount: number;
    available_amount: number;
    account_name: string;
  }>;
};
export type AppState = {
  owner: string;
  categories: Category[];
  accounts: Account[];
  currencies: string[];
  review: { transactions: number; receipts: number; emails: number };
  appUrl: string;
};
export type AppContext = {
  state: AppState;
  month: string;
  currency: string;
  revision: number;
  refresh: () => void;
  navigate: (path: string) => void;
  notify: (message: string) => void;
  setMonth: (value: string) => void;
};
export function EntryTable({
  entries,
  navigate,
  returnTo,
  selection,
}: {
  entries: Entry[];
  navigate: (path: string) => void;
  returnTo?: string;
  selection?: {
    ids: string[];
    disabled: boolean;
    toggle: (id: string) => void;
  };
}) {
  return (
    <div className="table-wrap entry-table">
      <table>
        <thead>
          <tr>
            <th>Merchant / description</th>
            <th>Date</th>
            <th>Category</th>
            <th>Account</th>
            <th className="right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>
                <div className="entry-merchant">
                  {selection && ["expense", "refund"].includes(entry.kind) && (
                    <label className="entry-select">
                      <input
                        type="checkbox"
                        aria-label={`Select transaction ${entry.merchant} ${shortDate(entry.booked_at)} ${money(entry.amount, entry.currency)}`}
                        checked={selection.ids.includes(entry.id)}
                        disabled={selection.disabled}
                        onChange={() => selection.toggle(entry.id)}
                      />
                    </label>
                  )}
                  <button
                    className="merchant-link"
                    onClick={() =>
                      navigate(
                        `/transactions/${entry.id}${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`,
                      )
                    }
                  >
                    <span className="merchant-avatar">
                      {initials(entry.merchant_group || entry.merchant)}
                    </span>
                    <span>
                      <strong>{entry.merchant_group || entry.merchant}</strong>
                      {entry.merchant_group &&
                        entry.merchant_group !== entry.merchant && (
                          <small>{entry.merchant}</small>
                        )}
                      <small>
                        {entry.description ||
                          (entry.kind === "transfer"
                            ? "Account transfer"
                            : entry.source === "cash"
                              ? "Cash payment"
                              : "Bank transaction")}
                      </small>
                    </span>
                  </button>
                </div>
              </td>
              <td className="entry-date nowrap">
                {shortDate(entry.booked_at)}
                {entry.status === "PDNG" && (
                  <div>
                    <Badge>Pending</Badge>
                  </div>
                )}
              </td>
              <td className="entry-category">
                {entry.allocations.length === 1 ? (
                  <Badge
                    variant={
                      entry.allocations[0].category_id === "uncategorized"
                        ? "warning"
                        : "neutral"
                    }
                  >
                    <i style={{ background: entry.allocations[0].color }} />
                    {entry.allocations[0].name}
                  </Badge>
                ) : entry.allocations.length > 1 ? (
                  <Badge>{entry.allocations.length} categories</Badge>
                ) : (
                  <Badge>{entry.kind.replace("_", " ")}</Badge>
                )}
              </td>
              <td className="entry-account muted small">
                {entry.account_name}
                {entry.receipt_not_required && (
                  <div className="receipt-marker">Receipt not required</div>
                )}
                {Boolean(entry.receipt_count) && (
                  <div className="receipt-marker">Receipt linked</div>
                )}
              </td>
              <td
                className={`entry-amount right amount ${entry.amount > 0 ? "positive" : ""}`}
              >
                {entry.amount > 0 ? "+" : ""}
                {money(entry.amount, entry.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
import { formatMoney as money } from "../lib/money";
