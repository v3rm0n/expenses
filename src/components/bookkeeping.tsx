"use client";
import { useState, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { Plus, Trash2, ArrowLeft } from "lucide-react";
import {
  api,
  useData,
  Loading,
  ErrorMessage,
  Empty,
  SectionTitle,
  shortDate,
  type AppContext,
} from "./ui";
import { ISODateInput } from "./iso-date-input";
import { AccountingPanel } from "./accounting";
import { formatMoney, decimalMoney, parseMoney } from "../lib/money";
import { randomEntryId } from "../lib/ids";
import {
  ACCOUNT_TYPES,
  type TrialBalance,
  type JournalDetail,
  type JournalPage,
  type JournalInput,
  type GeneralLedger,
  type AccountingAccount,
  type AccountType,
} from "../lib/accounting";

const views = [
  ["journal", "Journal"],
  ["ledger", "General ledger"],
  ["trial-balance", "Trial balance"],
  ["accounts", "Accounts"],
  ["statements", "Financial statements"],
];
const originName = {
  manual: "Manual",
  transaction: "Transaction",
  opening: "Opening balance",
};
const params = (values: Record<string, string | number | undefined>) => {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== "") result.set(key, String(value));
  return result.toString();
};
const monthWindow = (month: string) => ({
  from: `${month}-01`,
  to: new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0))
    .toISOString()
    .slice(0, 10),
});
const balanceText = (amount: number, currency: string) =>
  `${formatMoney(Math.abs(amount), currency)} ${amount < 0 ? "Cr" : "Dr"}`;

function Pagination({
  page,
  count,
  limit,
  change,
}: {
  page: number;
  count: number;
  limit: number;
  change: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(count / limit));
  return (
    <div className="bookkeeping-pagination">
      <span>
        {count} records · Page {page} of {pages}
      </span>
      <div className="button-row">
        <button
          className="button secondary"
          disabled={page <= 1}
          onClick={() => change(page - 1)}
        >
          Previous page
        </button>
        <button
          className="button secondary"
          disabled={page >= pages}
          onClick={() => change(page + 1)}
        >
          Next page
        </button>
      </div>
    </div>
  );
}

function DateFilters({
  initial,
  apply,
  children,
  required = false,
}: {
  initial: { from: string; to: string };
  apply: (range: { from: string; to: string }) => void;
  children?: ReactNode;
  required?: boolean;
}) {
  const [from, setFrom] = useState(initial.from),
    [to, setTo] = useState(initial.to);
  return (
    <form
      className="bookkeeping-filters"
      onSubmit={(event) => {
        event.preventDefault();
        apply({ from, to });
      }}
    >
      <label>
        From
        <ISODateInput
          value={from}
          onChange={(event) => setFrom(event.target.value)}
          required={required}
        />
      </label>
      <label>
        Through
        <ISODateInput
          value={to}
          onChange={(event) => setTo(event.target.value)}
          required={required}
        />
      </label>
      {children}
      <div className="button-row">
        <button className="button secondary">Apply filters</button>
        {!required && (
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              setFrom("");
              setTo("");
              apply({ from: "", to: "" });
            }}
          >
            All history
          </button>
        )}
      </div>
    </form>
  );
}

export function AdvancedView({
  context: ctx,
  view,
}: {
  context: AppContext;
  view: string;
}) {
  return (
    <div className="view-stack bookkeeping">
      <nav className="advanced-menu" aria-label="Advanced bookkeeping">
        {views.map(([path, label]) => (
          <button
            key={path}
            aria-current={view === path ? "page" : undefined}
            className={view === path ? "selected" : ""}
            onClick={() =>
              ctx.navigate(`/advanced/${path}?currency=${ctx.currency}`)
            }
          >
            {label}
          </button>
        ))}
      </nav>
      {view === "journal" && <JournalsView context={ctx} />}
      {view === "ledger" && <GeneralLedgerView context={ctx} />}
      {view === "trial-balance" && <TrialBalanceView context={ctx} />}
      {view === "accounts" && <AccountsView context={ctx} />}
      {view === "statements" && <StatementsView context={ctx} />}
    </div>
  );
}

function JournalEditor({
  context: ctx,
  detail,
  saved,
  cancel,
}: {
  context: AppContext;
  detail?: JournalDetail;
  saved: (id: string) => void;
  cancel: () => void;
}) {
  const currency = detail?.journal.currency || ctx.currency;
  const accounts = useData<TrialBalance>(
    `accounting/trial-balance?currency=${currency}`,
    ctx.revision,
  );
  const [date, setDate] = useState(
    detail?.journal.booked_at || `${ctx.month}-01`,
  );
  const [description, setDescription] = useState(
    detail?.journal.description || "",
  );
  const [reference, setReference] = useState(detail?.journal.reference || ""),
    [notes, setNotes] = useState(detail?.journal.notes || "");
  const [key] = useState(randomEntryId);
  const [lines, setLines] = useState(
    detail?.postings.map((p) => ({
      key: p.id,
      accountId: p.account_id,
      debit: p.debit ? decimalMoney(p.debit, currency) : "",
      credit: p.credit ? decimalMoney(p.credit, currency) : "",
      memo: p.memo,
    })) ||
      Array.from({ length: 2 }, () => ({
        key: randomEntryId(),
        accountId: "",
        debit: "",
        credit: "",
        memo: "",
      })),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const update = (
    index: number,
    field: "accountId" | "debit" | "credit" | "memo",
    value: string,
  ) =>
    setLines((current) =>
      current.map((line, i) =>
        i === index ? { ...line, [field]: value } : line,
      ),
    );
  let debit = 0n,
    credit = 0n,
    valid = true;
  try {
    for (const line of lines) {
      const d = parseMoney(line.debit || "0", currency),
        c = parseMoney(line.credit || "0", currency);
      debit += BigInt(d);
      credit += BigInt(c);
      if (!line.accountId || d < 0 || c < 0 || d > 0 === c > 0) valid = false;
    }
  } catch {
    valid = false;
  }
  if (
    debit > BigInt(Number.MAX_SAFE_INTEGER) ||
    credit > BigInt(Number.MAX_SAFE_INTEGER)
  )
    valid = false;
  const balanced = valid && debit === credit && debit > 0n;
  const amountText = (amount: bigint) =>
    amount <= BigInt(Number.MAX_SAFE_INTEGER) && amount >= 0n
      ? formatMoney(Number(amount), currency)
      : "Amount too large";
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!balanced) return;
    setBusy(true);
    setError(null);
    try {
      const input: JournalInput = {
        currency,
        date,
        description,
        reference,
        notes,
        postings: lines.map(({ key: lineKey, ...line }) => ({
          ...line,
          debit: line.debit || "0",
          credit: line.credit || "0",
        })),
      };
      const result = await api<JournalDetail>(
        detail
          ? `accounting/journals/${detail.journal.id}`
          : "accounting/journals",
        {
          ...input,
          ...(detail
            ? { version: detail.journal.version }
            : { idempotencyKey: key }),
        },
      );
      ctx.refresh();
      ctx.notify(detail ? "Journal updated." : "Journal posted.");
      saved(result.journal.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <SectionTitle
        title={detail ? "Edit manual journal" : "New journal entry"}
        description="Post a balanced entry to bookkeeping reports. Bank imports and receipts remain in Transactions."
      />
      <form className="padded-form journal-form" onSubmit={save}>
        <ErrorMessage message={error || accounts.error} />
        <div className="form-grid three">
          <label>
            Date
            <ISODateInput
              value={date}
              onChange={(event) => setDate(event.target.value)}
              required
              disabled={busy}
            />
          </label>
          <label>
            Reference
            <input
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              maxLength={100}
              disabled={busy}
            />
          </label>
          <label>
            Currency
            <input value={currency} readOnly />
          </label>
        </div>
        <label>
          Description
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            required
            maxLength={300}
            disabled={busy}
          />
        </label>
        <div className="journal-lines">
          {lines.map((line, index) => (
            <div className="journal-line" key={line.key}>
              <label>
                Account {index + 1}
                <select
                  value={line.accountId}
                  onChange={(event) =>
                    update(index, "accountId", event.target.value)
                  }
                  required
                  disabled={busy}
                >
                  <option value="">Choose an account</option>
                  {accounts.data?.accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.display_code ? `${account.display_code} · ` : ""}
                      {account.name} ({account.type})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Debit {index + 1}
                <input
                  inputMode="decimal"
                  value={line.debit}
                  onChange={(event) =>
                    update(index, "debit", event.target.value)
                  }
                  placeholder="0.00"
                  disabled={busy}
                />
              </label>
              <label>
                Credit {index + 1}
                <input
                  inputMode="decimal"
                  value={line.credit}
                  onChange={(event) =>
                    update(index, "credit", event.target.value)
                  }
                  placeholder="0.00"
                  disabled={busy}
                />
              </label>
              <label className="journal-memo">
                Memo {index + 1}
                <input
                  value={line.memo}
                  onChange={(event) =>
                    update(index, "memo", event.target.value)
                  }
                  maxLength={500}
                  disabled={busy}
                />
              </label>
              <button
                className="icon-button"
                type="button"
                aria-label={`Remove line ${index + 1}`}
                disabled={busy || lines.length <= 2}
                onClick={() =>
                  setLines((current) => current.filter((_, i) => i !== index))
                }
              >
                <Trash2 size={17} />
              </button>
            </div>
          ))}
        </div>
        <button
          className="button secondary"
          type="button"
          disabled={busy || lines.length >= 100}
          onClick={() =>
            setLines((current) => [
              ...current,
              {
                key: randomEntryId(),
                accountId: "",
                debit: "",
                credit: "",
                memo: "",
              },
            ])
          }
        >
          <Plus size={16} />
          Add line
        </button>
        <div
          className={`journal-totals ${balanced ? "balanced" : ""}`}
          aria-live="polite"
        >
          <span>
            Debits <strong>{amountText(debit)}</strong>
          </span>
          <span>
            Credits <strong>{amountText(credit)}</strong>
          </span>
          <strong>
            {balanced
              ? "Balanced"
              : "Enter a debit or credit on each line; totals must match."}
          </strong>
        </div>
        <label>
          Notes
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={4000}
            disabled={busy}
          />
        </label>
        <div className="button-row">
          <button
            className="button primary"
            disabled={busy || !balanced || !accounts.data}
          >
            {busy ? "Saving…" : detail ? "Save journal" : "Post journal"}
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={cancel}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
        {!accounts.loading && !accounts.data?.accounts.length && (
          <p>
            Create accounts in Advanced → Accounts before posting a journal.
          </p>
        )}
      </form>
    </section>
  );
}

function SelectedJournal({
  id,
  context: ctx,
  back,
}: {
  id: string;
  context: AppContext;
  back: () => void;
}) {
  const report = useData<JournalDetail>(
    `accounting/journals/${id}`,
    ctx.revision,
  );
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  if (!report.data)
    return (
      <>
        <ErrorMessage message={report.error} />
        {report.loading && <Loading />}
      </>
    );
  const detail = report.data,
    j = detail.journal,
    fmt = (amount: number) => (amount ? formatMoney(amount, j.currency) : "—");
  if (editing)
    return (
      <JournalEditor
        key={`${id}:${j.version}`}
        detail={detail}
        context={ctx}
        saved={() => setEditing(false)}
        cancel={() => setEditing(false)}
      />
    );
  const remove = async () => {
    if (!confirm("Delete this manual journal and all of its postings?")) return;
    setBusy(true);
    setError(null);
    try {
      await api(`accounting/journals/${id}`, { version: j.version }, "DELETE");
      ctx.refresh();
      ctx.notify("Manual journal deleted.");
      back();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <SectionTitle
        title={j.description}
        description={`${shortDate(j.booked_at)} · ${j.currency} · ${originName[j.origin]}${j.reference ? ` · ${j.reference}` : ""}`}
        action={
          j.origin === "manual" ? (
            <div className="button-row">
              <button
                className="button secondary"
                onClick={() => setEditing(true)}
                disabled={busy}
              >
                Edit journal
              </button>
              <button
                className="button danger"
                onClick={() => void remove()}
                disabled={busy}
              >
                Delete journal
              </button>
            </div>
          ) : undefined
        }
      />
      <ErrorMessage message={error || report.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Memo</th>
              <th>Debit</th>
              <th>Credit</th>
            </tr>
          </thead>
          <tbody>
            {detail.postings.map((p) => (
              <tr key={p.id}>
                <td>
                  <button
                    className="text-link"
                    onClick={() =>
                      ctx.navigate(
                        `/advanced/ledger?account=${p.account_id}&history=true&currency=${j.currency}`,
                      )
                    }
                  >
                    {p.name}
                  </button>
                </td>
                <td>{p.memo || "—"}</td>
                <td>{fmt(p.debit)}</td>
                <td>{fmt(p.credit)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={2}>Total</th>
              <th>{fmt(j.debit)}</th>
              <th>{fmt(j.credit)}</th>
            </tr>
          </tfoot>
        </table>
      </div>
      {(j.notes || j.transaction_id || j.opening_account_id) && (
        <div className="padded-form">
          {j.notes && <p className="journal-notes">{j.notes}</p>}
          {j.transaction_id && (
            <button
              className="button secondary"
              onClick={() => ctx.navigate(`/transactions/${j.transaction_id}`)}
            >
              Open source transaction
            </button>
          )}
          {j.opening_account_id && (
            <button
              className="button secondary"
              onClick={() =>
                ctx.navigate(`/advanced/accounts?currency=${j.currency}`)
              }
            >
              Manage opening balance
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function JournalsView({ context: ctx }: { context: AppContext }) {
  const searchParams = useSearchParams(),
    entry = searchParams.get("entry");
  const [range, setRange] = useState(monthWindow(ctx.month)),
    [page, setPage] = useState(1);
  const [search, setSearch] = useState(""),
    [origin, setOrigin] = useState("all");
  const [filter, setFilter] = useState({ search: "", origin: "all" });
  const report = useData<JournalPage>(
    entry
      ? null
      : `accounting/journals?${params({ currency: ctx.currency, ...range, ...filter, page })}`,
    ctx.revision,
  );
  const back = () => ctx.navigate(`/advanced/journal?currency=${ctx.currency}`);
  const select = (id: string) =>
    ctx.navigate(`/advanced/journal?entry=${id}&currency=${ctx.currency}`);
  if (entry)
    return (
      <div className="view-stack">
        <button className="text-link" onClick={back}>
          <ArrowLeft size={16} />
          All journals
        </button>
        {entry === "new" ? (
          <JournalEditor context={ctx} saved={select} cancel={back} />
        ) : (
          <SelectedJournal key={entry} id={entry} context={ctx} back={back} />
        )}
      </div>
    );
  return (
    <section className="panel">
      <SectionTitle
        title="Journal"
        description="All imported, opening, and manual journals in this currency."
        action={
          <button className="button primary" onClick={() => select("new")}>
            <Plus size={16} />
            New journal entry
          </button>
        }
      />
      <DateFilters
        initial={range}
        apply={(value) => {
          setRange(value);
          setFilter({ search, origin });
          setPage(1);
        }}
      >
        <label>
          Search journals
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            maxLength={200}
            placeholder="Description or reference"
          />
        </label>
        <label>
          Source
          <select
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
          >
            <option value="all">All sources</option>
            <option value="manual">Manual</option>
            <option value="transaction">Transactions</option>
            <option value="opening">Opening balances</option>
          </select>
        </label>
      </DateFilters>
      <ErrorMessage message={report.error} />
      {report.loading && !report.data && <Loading />}
      {report.data &&
        (!report.data.rows.length ? (
          <Empty
            title="No journal entries"
            text="Choose another period or post a manual entry."
          />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description / reference</th>
                    <th>Source</th>
                    <th>Debits</th>
                    <th>Credits</th>
                  </tr>
                </thead>
                <tbody>
                  {report.data.rows.map((j) => (
                    <tr key={j.id}>
                      <td>{shortDate(j.booked_at)}</td>
                      <td>
                        <button
                          className="text-link"
                          onClick={() => select(j.id)}
                        >
                          {j.description}
                        </button>
                        {j.reference && <small>{j.reference}</small>}
                      </td>
                      <td>{originName[j.origin]}</td>
                      <td>{formatMoney(j.debit, j.currency)}</td>
                      <td>{formatMoney(j.credit, j.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination {...report.data} change={setPage} />
          </>
        ))}
    </section>
  );
}

function GeneralLedgerView({ context: ctx }: { context: AppContext }) {
  const search = useSearchParams();
  const [accountId, setAccountId] = useState(search.get("account") || ""),
    [page, setPage] = useState(1);
  const [range, setRange] = useState(
    search.get("history") === "true"
      ? { from: "", to: search.get("to") || "" }
      : {
          from: search.get("from") || monthWindow(ctx.month).from,
          to: search.get("to") || monthWindow(ctx.month).to,
        },
  );
  const accounts = useData<TrialBalance>(
    `accounting/trial-balance?currency=${ctx.currency}`,
    ctx.revision,
  );
  const selectedAccountId = accounts.data?.accounts.some(
    (account) => account.id === accountId,
  )
    ? accountId
    : "";
  const report = useData<GeneralLedger>(
    selectedAccountId
      ? `accounting/general-ledger?${params({ account: selectedAccountId, ...range, page })}`
      : null,
    ctx.revision,
  );
  const fmt = (amount: number) =>
    formatMoney(amount, report.data?.account.currency || ctx.currency);
  return (
    <section className="panel">
      <SectionTitle
        title="General ledger"
        description="Account postings in date order, with an opening and running balance."
      />
      <div className="padded-form">
        <label>
          Ledger account
          <select
            value={selectedAccountId}
            onChange={(event) => {
              setAccountId(event.target.value);
              setPage(1);
            }}
          >
            <option value="">Choose an account</option>
            {accounts.data?.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.display_code ? `${a.display_code} · ` : ""}
                {a.name} ({a.type})
              </option>
            ))}
          </select>
        </label>
      </div>
      <DateFilters
        initial={range}
        apply={(value) => {
          setRange(value);
          setPage(1);
        }}
      />
      <ErrorMessage message={report.error || accounts.error} />
      {((accounts.loading && !accounts.data) ||
        (selectedAccountId && report.loading && !report.data)) && <Loading />}
      {!selectedAccountId && !accounts.loading && (
        <Empty
          title="Choose a ledger account"
          text="Inspect balances and individual postings for any account."
        />
      )}
      {selectedAccountId && report.data && (
        <>
          <div className="bookkeeping-summary">
            <span>
              Opening{" "}
              <strong>
                {balanceText(report.data.opening, report.data.account.currency)}
              </strong>
            </span>
            <span>
              Debits <strong>{fmt(report.data.debit)}</strong>
            </span>
            <span>
              Credits <strong>{fmt(report.data.credit)}</strong>
            </span>
            <span>
              Closing{" "}
              <strong>
                {balanceText(report.data.closing, report.data.account.currency)}
              </strong>
            </span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Journal / memo</th>
                  <th>Source</th>
                  <th>Debit</th>
                  <th>Credit</th>
                  <th>Running balance</th>
                </tr>
              </thead>
              <tbody>
                {report.data.rows.map((row) => (
                  <tr key={row.id}>
                    <td>{shortDate(row.booked_at)}</td>
                    <td>
                      <button
                        className="text-link"
                        onClick={() =>
                          ctx.navigate(
                            `/advanced/journal?entry=${row.entry_id}&currency=${ctx.currency}`,
                          )
                        }
                      >
                        {row.description}
                      </button>
                      <small>
                        {[row.reference, row.memo].filter(Boolean).join(" · ")}
                      </small>
                    </td>
                    <td>{originName[row.origin]}</td>
                    <td>{row.debit ? fmt(row.debit) : "—"}</td>
                    <td>{row.credit ? fmt(row.credit) : "—"}</td>
                    <td>
                      {balanceText(row.balance, report.data!.account.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!report.data.rows.length && (
            <p className="padded-form">No postings in this period.</p>
          )}
          <Pagination {...report.data} change={setPage} />
        </>
      )}
    </section>
  );
}

function TrialBalanceView({ context: ctx }: { context: AppContext }) {
  const [through, setThrough] = useState(monthWindow(ctx.month).to),
    [draft, setDraft] = useState(through);
  const report = useData<TrialBalance>(
    `accounting/trial-balance?${params({ currency: ctx.currency, through })}`,
    ctx.revision,
  );
  const fmt = (amount: number) =>
    amount ? formatMoney(amount, ctx.currency) : "—";
  return (
    <section className="panel">
      <SectionTitle
        title="Trial balance"
        description="Net debit and credit balances for every account as of the selected date."
      />
      <form
        className="bookkeeping-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setThrough(draft);
        }}
      >
        <label>
          As of
          <ISODateInput
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <div className="button-row">
          <button className="button secondary">Apply date</button>
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              setThrough("");
              setDraft("");
            }}
          >
            All history
          </button>
        </div>
      </form>
      <ErrorMessage message={report.error} />
      {report.loading && !report.data && <Loading />}
      {report.data && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Type</th>
                <th>Debit balance</th>
                <th>Credit balance</th>
              </tr>
            </thead>
            <tbody>
              {report.data.accounts.map((a) => (
                <tr key={a.id}>
                  <td>
                    <button
                      className="text-link"
                      onClick={() =>
                        ctx.navigate(
                          `/advanced/ledger?${params({ account: a.id, currency: ctx.currency, history: "true", to: through })}`,
                        )
                      }
                    >
                      {a.name}
                    </button>
                  </td>
                  <td>{a.type}</td>
                  <td>{fmt(Math.max(a.balance, 0))}</td>
                  <td>{fmt(Math.max(-a.balance, 0))}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={2}>Total</th>
                <th>{formatMoney(report.data.balance_debit, ctx.currency)}</th>
                <th>{formatMoney(report.data.balance_credit, ctx.currency)}</th>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

function AccountsView({ context: ctx }: { context: AppContext }) {
  const [creating, setCreating] = useState(false),
    [code, setCode] = useState(""),
    [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("asset"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("accounting/accounts", {
        code,
        name,
        type,
        currency: ctx.currency,
      });
      ctx.refresh();
      ctx.notify("Ledger account created.");
      setCreating(false);
      setCode("");
      setName("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="view-stack">
      <section className="panel">
        <SectionTitle
          title="Chart of accounts"
          description={`Manage accounts and opening balances in ${ctx.currency}.`}
          action={
            <button
              className="button primary"
              onClick={() => setCreating(!creating)}
            >
              <Plus size={16} />
              New account
            </button>
          }
        />
        {creating && (
          <form className="padded-form" onSubmit={save}>
            <ErrorMessage message={error} />
            <div className="form-grid three">
              <label>
                Account code
                <input
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  pattern="[A-Za-z0-9._\-]{1,40}"
                  maxLength={40}
                  required
                  disabled={busy}
                  placeholder="2100"
                />
              </label>
              <label>
                Account name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={200}
                  required
                  disabled={busy}
                  placeholder="Credit card payable"
                />
              </label>
              <label>
                Account type
                <select
                  value={type}
                  onChange={(event) =>
                    setType(event.target.value as AccountType)
                  }
                  disabled={busy}
                >
                  {ACCOUNT_TYPES.map((value) => (
                    <option key={value} value={value}>
                      {value[0].toUpperCase() + value.slice(1)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="button-row">
              <button className="button primary" disabled={busy}>
                {busy ? "Saving…" : "Create account"}
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => setCreating(false)}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>
      <AccountingPanel context={ctx} />
    </div>
  );
}

type Statements = {
  rows: (Pick<AccountingAccount, "id" | "name" | "type" | "balance"> & {
    period_amount: number;
  })[];
  income: number;
  expenses: number;
  profit: number;
  assets: number;
  liabilities: number;
  equity: number;
  earnings: number;
  total_equity: number;
  liabilities_and_equity: number;
};
function StatementsView({ context: ctx }: { context: AppContext }) {
  const [range, setRange] = useState(monthWindow(ctx.month));
  const report = useData<Statements>(
    `accounting/statements?${params({ currency: ctx.currency, ...range })}`,
    ctx.revision,
  );
  const fmt = (amount: number) => formatMoney(amount, ctx.currency);
  const row = (label: string, amount: number, key?: string) => (
    <tr key={key || label}>
      <td>{label}</td>
      <td>{fmt(amount)}</td>
    </tr>
  );
  return (
    <div className="view-stack">
      <section className="panel">
        <SectionTitle
          title="Financial statements"
          description="Income and expenses for the period, with a balance sheet through its end date."
        />
        <DateFilters initial={range} required apply={setRange} />
        <ErrorMessage message={report.error} />
      </section>
      {report.loading && !report.data && <Loading />}
      {report.data && (
        <div className="settings-grid">
          <section className="panel">
            <SectionTitle
              title="Income statement"
              description={`${shortDate(range.from)} – ${shortDate(range.to)}`}
            />
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th colSpan={2}>Income</th>
                  </tr>
                  {report.data.rows
                    .filter((a) => a.type === "income")
                    .map((a) => row(a.name, -(a.period_amount || 0), a.id))}
                  {row("Total income", report.data.income)}
                  <tr>
                    <th colSpan={2}>Expenses</th>
                  </tr>
                  {report.data.rows
                    .filter((a) => a.type === "expense")
                    .map((a) => row(a.name, a.period_amount || 0, a.id))}
                  {row("Total expenses", report.data.expenses)}
                </tbody>
                <tfoot>
                  <tr>
                    <th>Net income</th>
                    <th>{fmt(report.data.profit)}</th>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
          <section className="panel">
            <SectionTitle
              title="Balance sheet"
              description={`As of ${shortDate(range.to)}`}
            />
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th colSpan={2}>Assets</th>
                  </tr>
                  {report.data.rows
                    .filter((a) => a.type === "asset")
                    .map((a) => row(a.name, a.balance, a.id))}
                  {row("Total assets", report.data.assets)}
                  <tr>
                    <th colSpan={2}>Liabilities</th>
                  </tr>
                  {report.data.rows
                    .filter((a) => a.type === "liability")
                    .map((a) => row(a.name, -a.balance, a.id))}
                  {row("Total liabilities", report.data.liabilities)}
                  <tr>
                    <th colSpan={2}>Equity</th>
                  </tr>
                  {report.data.rows
                    .filter((a) => a.type === "equity")
                    .map((a) => row(a.name, -a.balance, a.id))}
                  {row("Accumulated earnings", report.data.earnings)}
                  {row("Total equity", report.data.total_equity)}
                </tbody>
                <tfoot>
                  <tr>
                    <th>Liabilities and equity</th>
                    <th>{fmt(report.data.liabilities_and_equity)}</th>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
