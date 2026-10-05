"use client";
import { ISODateInput } from "./iso-date-input";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { randomEntryId } from "../lib/ids";
import { suggestedDescriptionPattern } from "../lib/similar-transactions";
import {
  ArrowLeft,
  Plus,
  Upload,
  ReceiptText,
  ExternalLink,
  Trash2,
  Link2,
  WalletCards,
  RefreshCw,
  X,
  Search,
  ChevronLeft,
  ChevronRight,
  CheckCheck,
  Clock3,
} from "lucide-react";
import {
  api,
  updateQuery,
  useData,
  Loading,
  ErrorMessage,
  Empty,
  Badge,
  SectionTitle,
  EntryTable,
  TextLink,
  shortDate,
  dateTime,
  type AppContext,
  type Entry,
  type Receipt,
  type ReceiptDetail,
} from "./ui";
import { decimalMoney, formatMoney, parseMoney } from "../lib/money";

export function TransactionsView({ context: ctx }: { context: AppContext }) {
  const searchParams = useSearchParams();
  const search = searchParams.get("search") || "",
    category = searchParams.get("category") || "",
    account = searchParams.get("account") || "",
    kind = searchParams.get("kind") || "",
    receipt = searchParams.get("receipt") || "",
    status = searchParams.get("status") || "",
    history = searchParams.get("history") === "true",
    page = Math.max(1, Math.floor(Number(searchParams.get("page")) || 1)),
    minimum = searchParams.get("minimum") || "",
    maximum = searchParams.get("maximum") || "";
  const [showNew, setShowNew] = useState(searchParams.get("new") === "true");
  useEffect(
    () => setShowNew(searchParams.get("new") === "true"),
    [searchParams],
  );
  const setFilter = (key: string, value: string) =>
    updateQuery({ [key]: value }, true);
  const params = new URLSearchParams({
    currency: ctx.currency,
    page: String(page),
    ...(history ? {} : { month: ctx.month }),
    ...(search ? { search } : {}),
    ...(category ? { category } : {}),
    ...(account ? { account } : {}),
    ...(kind ? { kind } : {}),
    ...(receipt ? { receipt } : {}),
    ...(status ? { status } : {}),
    ...(minimum ? { minimum } : {}),
    ...(maximum ? { maximum } : {}),
  });
  const { data, error, loading } = useData<{
    rows: Entry[];
    count: number;
    limit: number;
  }>(`transactions?${params}`, ctx.revision, 30000);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const selectionKey = params.toString();
  useEffect(() => {
    setSelected([]);
    setBulkError(null);
  }, [selectionKey]);
  const visibleSelected = selected.filter((id) =>
    data?.rows.some((row) => row.id === id),
  );
  const selectable =
    data?.rows.filter((row) => ["expense", "refund"].includes(row.kind)) || [];
  const bulkReceiptRequirement = async (value: boolean) => {
    setBulkBusy(true);
    setBulkError(null);
    try {
      const result = await api<{ count: number }>(
        "transactions/receipt-requirement",
        {
          ids: visibleSelected,
          receiptNotRequired: value,
        },
      );
      setSelected([]);
      ctx.notify(
        `${result.count} transactions marked receipt ${value ? "not required" : "required"}.`,
      );
      ctx.refresh();
    } catch (error) {
      setBulkError((error as Error).message);
    } finally {
      setBulkBusy(false);
    }
  };
  const exportParams = new URLSearchParams(params);
  exportParams.delete("page");
  const returnTo = `/transactions?${searchParams.toString()}`;
  return (
    <div className="view-stack">
      <div className="action-row">
        <div className="tabs">
          <button
            className={!history ? "selected" : ""}
            onClick={() => setFilter("history", "")}
          >
            Selected month
          </button>
          <button
            className={history ? "selected" : ""}
            onClick={() => setFilter("history", "true")}
          >
            All history
          </button>
        </div>
        <div className="button-row">
          <a className="button secondary" href={`/api/export?${exportParams}`}>
            Export CSV
          </a>
          <button
            className="button primary"
            onClick={() => updateQuery({ new: "true" })}
          >
            <Plus size={16} />
            Cash entry
          </button>
        </div>
      </div>
      <section className="panel">
        <div className="filters">
          <label className="search-field">
            <Search size={17} />
            <input
              aria-label="Search transactions"
              placeholder="Search merchant or description…"
              value={search}
              onChange={(e) => setFilter("search", e.target.value)}
            />
          </label>
          <select
            aria-label="Filter category"
            value={category}
            onChange={(e) => setFilter("category", e.target.value)}
          >
            <option value="">All categories</option>
            {ctx.state.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter account"
            value={account}
            onChange={(e) => setFilter("account", e.target.value)}
          >
            <option value="">All accounts</option>
            {ctx.state.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.nickname || a.name}
                {a.currency ? ` · ${a.currency}` : ""}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter payment type"
            value={kind}
            onChange={(e) => setFilter("kind", e.target.value)}
          >
            <option value="">All types</option>
            {[
              "expense",
              "income",
              "refund",
              "transfer",
              "cash_movement",
              "investment",
              "pension",
            ].map((k) => (
              <option key={k} value={k}>
                {k.replace("_", " ")}
              </option>
            ))}
          </select>
        </div>
        <div className="filters secondary-filters">
          <select
            aria-label="Filter receipt status"
            value={receipt}
            onChange={(e) => setFilter("receipt", e.target.value)}
          >
            <option value="">Any receipt status</option>
            <option value="linked">Receipt linked</option>
            <option value="missing">Receipt missing</option>
            <option value="not_required">Receipt not required</option>
          </select>
          <select
            aria-label="Filter booking status"
            value={status}
            onChange={(e) => setFilter("status", e.target.value)}
          >
            <option value="">Booked & pending</option>
            <option value="BOOK">Booked</option>
            <option value="PDNG">Pending</option>
          </select>
          <input
            aria-label="Minimum amount"
            placeholder="Min amount"
            inputMode="decimal"
            value={minimum}
            onChange={(e) => setFilter("minimum", e.target.value)}
          />
          <input
            aria-label="Maximum amount"
            placeholder="Max amount"
            inputMode="decimal"
            value={maximum}
            onChange={(e) => setFilter("maximum", e.target.value)}
          />
        </div>
        <ErrorMessage message={error || bulkError} />
        {selectable.length > 0 && (
          <div className="action-row bulk-receipt-actions">
            <label className="checkbox">
              <input
                type="checkbox"
                aria-label="Select all payments on this page"
                checked={selectable.every((row) =>
                  visibleSelected.includes(row.id),
                )}
                disabled={bulkBusy}
                onChange={(e) =>
                  setSelected(
                    e.target.checked ? selectable.map((row) => row.id) : [],
                  )
                }
              />
              {visibleSelected.length
                ? `${visibleSelected.length} selected`
                : "Select payments"}
            </label>
            <div className="button-row">
              <button
                className="button secondary"
                disabled={bulkBusy || !visibleSelected.length}
                onClick={() => void bulkReceiptRequirement(true)}
              >
                Mark receipt not required
              </button>
              <button
                className="button secondary"
                disabled={bulkBusy || !visibleSelected.length}
                onClick={() => void bulkReceiptRequirement(false)}
              >
                Require receipts
              </button>
            </div>
          </div>
        )}
        {!data && loading ? (
          <Loading />
        ) : data?.rows.length ? (
          <EntryTable
            entries={data.rows}
            navigate={ctx.navigate}
            returnTo={returnTo}
            selection={{
              ids: visibleSelected,
              disabled: bulkBusy,
              toggle: (id) =>
                setSelected((ids) =>
                  ids.includes(id)
                    ? ids.filter((value) => value !== id)
                    : [...ids, id],
                ),
            }}
          />
        ) : (
          <Empty
            title="No matching transactions"
            text="Adjust your filters, connect a bank, or add a cash expense."
          />
        )}
        {data && (
          <div className="pagination">
            <span>
              {data.count
                ? `${(page - 1) * data.limit + 1}–${Math.min(page * data.limit, data.count)} of ${data.count}`
                : "0 transactions"}
            </span>
            <div>
              <button
                className="icon-button"
                disabled={page === 1}
                aria-label="Previous page"
                onClick={() => updateQuery({ page: String(page - 1) })}
              >
                <ChevronLeft size={18} />
              </button>
              <span>Page {page}</span>
              <button
                className="icon-button"
                disabled={page * data.limit >= data.count}
                aria-label="Next page"
                onClick={() => updateQuery({ page: String(page + 1) })}
              >
                <ChevronRight size={18} />
              </button>
            </div>
          </div>
        )}
      </section>
      {showNew && (
        <CashModal
          context={ctx}
          close={() => {
            setShowNew(false);
            updateQuery({ new: null });
          }}
        />
      )}
    </div>
  );
}
function CashModal({
  context: ctx,
  close,
}: {
  context: AppContext;
  close: () => void;
}) {
  const [merchant, setMerchant] = useState(""),
    [amount, setAmount] = useState(""),
    [date, setDate] = useState(
      new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Tallinn" }).format(
        new Date(),
      ),
    ),
    [currency, setCurrency] = useState(ctx.currency),
    [category, setCategory] = useState("uncategorized"),
    [kind, setKind] = useState("expense"),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const key = useRef(randomEntryId());
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("transactions", {
        merchant,
        amount,
        date,
        currency,
        category,
        kind,
        idempotencyKey: key.current,
      });
      ctx.notify("Cash entry recorded.");
      ctx.refresh();
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cash-title"
      >
        <div className="modal-heading">
          <h2 id="cash-title">Record a cash entry</h2>
          <button
            className="icon-button"
            aria-label="Close cash entry"
            onClick={close}
            disabled={busy}
          >
            <X size={20} />
          </button>
        </div>
        <p className="muted">For purchases, income, or refunds paid in cash.</p>
        <form onSubmit={save}>
          <ErrorMessage message={error} />
          <label>
            Merchant or description
            <input
              required
              value={merchant}
              onChange={(e) => setMerchant(e.target.value)}
              maxLength={200}
              placeholder="Where did the money go?"
            />
          </label>
          <div className="form-grid">
            <label>
              Amount
              <input
                inputMode="decimal"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
            </label>
            <label>
              Currency
              <input
                required
                pattern="[A-Z]{3}"
                maxLength={3}
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            </label>
            <label>
              Date
              <ISODateInput
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
            <label>
              Type
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="expense">Expense</option>
                <option value="income">Income</option>
                <option value="refund">Refund</option>
              </select>
            </label>
          </div>
          {kind !== "income" && (
            <label>
              Category
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {ctx.state.categories
                  .filter((c) => !["investments", "pension"].includes(c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <button className="button primary wide" disabled={busy}>
            {busy ? "Saving…" : "Record entry"}
          </button>
        </form>
      </section>
    </div>
  );
}
export function TransactionDetailView({
  context: ctx,
  id,
  review,
}: {
  context: AppContext;
  id: string;
  review?: {
    returnTo: string;
    advancing: boolean;
    onNext: () => Promise<void>;
  };
}) {
  const searchParams = useSearchParams();
  const requestedReturn = searchParams.get("returnTo") || "";
  const returnTo = /^\/(?:transactions|review)(?:\?|$)/.test(requestedReturn)
    ? requestedReturn
    : "/transactions";
  const { data, error, loading } = useData<Entry>(
    `transactions/${id}`,
    ctx.revision,
  );
  const [applySimilar, setApplySimilar] = useState(false),
    [includeManual, setIncludeManual] = useState(false),
    [similarPattern, setSimilarPattern] = useState("");
  const [receiptNotRequired, setReceiptNotRequired] = useState(false),
    [receiptBusy, setReceiptBusy] = useState(false);
  const loadedClassification = useRef<string | null>(null);
  const [kind, setKind] = useState("expense"),
    [note, setNote] = useState(""),
    [automatic, setAutomatic] = useState(false),
    [rows, setRows] = useState<Array<{ category_id: string; amount: string }>>(
      [],
    ),
    [saveError, setSaveError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const canApplySimilar =
    Boolean(data?.merchant.trim()) &&
    !automatic &&
    rows.length === 1 &&
    kind === data?.kind &&
    ["expense", "refund"].includes(kind);
  const similar = useData<{
    count: number;
    examples: Array<{
      id: string;
      description: string;
      booked_at: string;
      amount: number;
      currency: string;
    }>;
  }>(
    applySimilar && canApplySimilar
      ? `transactions/${id}/similar?${new URLSearchParams({ pattern: similarPattern, includeManual: String(includeManual) })}`
      : null,
    ctx.revision,
  );
  useEffect(() => {
    if (data) {
      setReceiptNotRequired(data.receipt_not_required);
      const signature = JSON.stringify([
        data.id,
        data.kind,
        data.note,
        data.allocations,
      ]);
      // A receipt action refreshes this record too. Keep unsaved category edits
      // when only receipt links or the receipt requirement have changed.
      if (loadedClassification.current === signature) return;
      loadedClassification.current = signature;
      setApplySimilar(false);
      setIncludeManual(false);
      setSimilarPattern(suggestedDescriptionPattern(data.description));
      setKind(data.kind);
      setNote(data.note);
      setAutomatic(false);
      setRows(
        data.allocations.length
          ? data.allocations.map((a) => ({
              category_id: a.category_id,
              amount: decimalMoney(Number(a.amount), data.currency),
            }))
          : [
              {
                category_id: "uncategorized",
                amount: decimalMoney(-data.amount, data.currency),
              },
            ],
      );
    }
  }, [data]);
  if (!data)
    return (
      <>
        <ErrorMessage message={error} />
        {loading && <Loading />}
      </>
    );
  const receiptComplete =
    Boolean(data.receipts?.length) &&
    data.receipts!.reduce((sum, receipt) => sum + receipt.linked_amount, 0) >=
      Math.abs(data.amount) &&
    data.receipts!.every((receipt) =>
      ["ready", "matched"].includes(receipt.status),
    );
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setSaveError(null);
    try {
      const result = await api<{ count: number }>(`transactions/${id}`, {
        kind,
        note,
        automatic,
        allocations: rows,
        ...(applySimilar && canApplySimilar
          ? { similarPattern, similarIncludeManual: includeManual }
          : {}),
      });
      ctx.notify(
        applySimilar && canApplySimilar
          ? `${result.count} transactions categorized.`
          : "Transaction updated.",
      );
      ctx.refresh();
      if (review) await review.onNext();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const updateReceiptRequirement = async (value: boolean) => {
    const previous = receiptNotRequired;
    setReceiptNotRequired(value);
    setReceiptBusy(true);
    setSaveError(null);
    try {
      await api(`transactions/${id}/receipt-requirement`, {
        receiptNotRequired: value,
      });
      ctx.notify(
        value
          ? "Payment excluded from receipt coverage."
          : "Payment included in receipt coverage.",
      );
      ctx.refresh();
    } catch (e) {
      setReceiptNotRequired(previous);
      setSaveError((e as Error).message);
    } finally {
      setReceiptBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm("Delete this cash entry and remove its receipt links?"))
      return;
    try {
      await api(`transactions/${id}`, undefined, "DELETE");
      ctx.refresh();
      ctx.notify("Cash entry deleted.");
      if (review) await review.onNext();
      else ctx.navigate(returnTo);
    } catch (e) {
      setSaveError((e as Error).message);
    }
  };
  return (
    <div className="view-stack">
      {!review && (
        <TextLink onClick={() => ctx.navigate(returnTo)}>
          <ArrowLeft size={15} />
          All transactions
        </TextLink>
      )}
      <ErrorMessage message={error || saveError} />
      <div className="detail-grid">
        <section className="panel">
          <div className="payment-heading">
            <div className="large-avatar">
              <WalletCards size={30} />
            </div>
            <div>
              <h2>{data.merchant}</h2>
              <p>{data.description || "Bank transaction"}</p>
            </div>
            <strong className="payment-amount">
              {formatMoney(data.amount, data.currency)}
            </strong>
          </div>
          <div className="detail-facts">
            <div>
              <span>Date</span>
              <strong>{shortDate(data.booked_at)}</strong>
            </div>
            <div>
              <span>Account</span>
              <strong>{data.account_name}</strong>
            </div>
            <div>
              <span>Status</span>
              <Badge variant={data.status === "BOOK" ? "success" : "warning"}>
                {data.status === "BOOK" ? "Booked" : "Pending"}
              </Badge>
            </div>
          </div>
          {review && (
            <div className="review-checks">
              <Badge
                variant={
                  !data.allocations.length ||
                  data.allocations.some(
                    (a) => a.category_id === "uncategorized" && a.amount !== 0,
                  )
                    ? "warning"
                    : "success"
                }
              >
                {!data.allocations.length ||
                data.allocations.some(
                  (a) => a.category_id === "uncategorized" && a.amount !== 0,
                )
                  ? "Needs category"
                  : "Category set"}
              </Badge>
              <Badge
                variant={
                  receiptNotRequired || receiptComplete ? "success" : "warning"
                }
              >
                {receiptNotRequired
                  ? "Receipt not required"
                  : receiptComplete
                    ? "Receipt linked"
                    : data.receipts?.length
                      ? "Receipt incomplete"
                      : "Receipt missing"}
              </Badge>
            </div>
          )}
          <form onSubmit={save} className="padded-form">
            <SectionTitle
              title="Classification"
              description="Your corrections take priority over automatic categories."
            />
            <label>
              Payment type
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="expense" disabled={data.amount > 0}>
                  Expense
                </option>
                <option value="income" disabled={data.amount < 0}>
                  Income
                </option>
                <option value="refund" disabled={data.amount < 0}>
                  Refund
                </option>
                <option value="transfer">Transfer between my accounts</option>
                <option value="investment">Investment transfer</option>
                <option value="pension">Pension contribution</option>
                <option value="cash_movement">
                  Cash withdrawal / movement
                </option>
              </select>
            </label>
            {["investment", "pension"].includes(kind) && (
              <p className="form-help">
                {data.amount < 0 ? "Contribution" : "Money returned"} · Shown
                separately from spending and income.
              </p>
            )}
            <label className="checkbox">
              <input
                type="checkbox"
                checked={automatic}
                onChange={(e) => setAutomatic(e.target.checked)}
              />
              Use automatic categories and receipt breakdown
            </label>
            {["expense", "refund"].includes(kind) && !automatic && (
              <>
                <div className="allocation-list">
                  {rows.map((row, i) => (
                    <div className="allocation-row" key={i}>
                      <select
                        aria-label={`Category ${i + 1}`}
                        value={row.category_id}
                        onChange={(e) =>
                          setRows((items) =>
                            items.map((r, n) =>
                              n === i
                                ? { ...r, category_id: e.target.value }
                                : r,
                            ),
                          )
                        }
                      >
                        {ctx.state.categories
                          .filter(
                            (c) => !["investments", "pension"].includes(c.id),
                          )
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                      </select>
                      <input
                        aria-label={`Category amount ${i + 1}`}
                        inputMode="decimal"
                        value={row.amount}
                        onChange={(e) =>
                          setRows((items) =>
                            items.map((r, n) =>
                              n === i ? { ...r, amount: e.target.value } : r,
                            ),
                          )
                        }
                      />
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove category ${i + 1}`}
                        onClick={() =>
                          setRows((items) => items.filter((_, n) => n !== i))
                        }
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="allocation-footer">
                  <button
                    type="button"
                    className="text-link"
                    onClick={() =>
                      setRows((items) => [
                        ...items,
                        {
                          category_id: "uncategorized",
                          amount: decimalMoney(0, data.currency),
                        },
                      ])
                    }
                  >
                    <Plus size={15} />
                    Split another category
                  </button>
                  <span>
                    Total must equal {formatMoney(-data.amount, data.currency)}
                  </span>
                </div>
              </>
            )}
            {canApplySimilar && (
              <div className="view-stack">
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={applySimilar}
                    onChange={(e) => setApplySimilar(e.target.checked)}
                  />
                  Apply category to similar transactions
                </label>
                {applySimilar && (
                  <>
                    <label>
                      Description contains
                      <input
                        value={similarPattern}
                        maxLength={200}
                        onChange={(e) => setSimilarPattern(e.target.value)}
                        placeholder="Leave blank to match all payments to this merchant"
                      />
                    </label>
                    <p className="form-help">
                      Same merchant ({data.merchant}), payment type and
                      currency, across all history. Receipt-linked payments are
                      skipped. Manual corrections are kept unless included
                      below. Each payment keeps its own amount and note.
                    </p>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={includeManual}
                        onChange={(e) => setIncludeManual(e.target.checked)}
                      />
                      Include manually categorized transactions
                    </label>
                    <ErrorMessage message={similar.error} />
                    {similar.loading ? (
                      <Loading />
                    ) : (
                      similar.data && (
                        <div aria-live="polite">
                          <p>
                            {similar.data.count} other matching transactions
                            will be categorized on save.
                          </p>
                          {similar.data.examples.map((entry) => (
                            <p className="form-help" key={entry.id}>
                              {shortDate(entry.booked_at)} ·{" "}
                              {entry.description || data.merchant} ·{" "}
                              {formatMoney(entry.amount, entry.currency)}
                            </p>
                          ))}
                        </div>
                      )
                    )}
                  </>
                )}
              </div>
            )}
            <label>
              Personal note
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={2000}
                placeholder="Anything you’d like to remember…"
              />
            </label>
            <div className="button-row">
              <button
                className="button primary"
                disabled={
                  busy ||
                  receiptBusy ||
                  review?.advancing ||
                  (applySimilar &&
                    canApplySimilar &&
                    (similar.loading ||
                      Boolean(similar.error) ||
                      !similar.data))
                }
              >
                {busy
                  ? "Saving…"
                  : review
                    ? "Save and next"
                    : applySimilar && canApplySimilar
                      ? `Save and categorize ${1 + (similar.data?.count || 0)} transactions`
                      : "Save changes"}
              </button>
              {review && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy || receiptBusy || review.advancing}
                  onClick={() => void review.onNext().catch(() => {})}
                >
                  Skip for now
                </button>
              )}
              {data.source === "cash" && (
                <button
                  type="button"
                  className="button danger"
                  onClick={remove}
                >
                  <Trash2 size={16} />
                  Delete cash entry
                </button>
              )}
            </div>
          </form>
        </section>
        <aside className="panel">
          <SectionTitle title="Receipts" />
          {["expense", "refund"].includes(data.kind) && (
            <div className="padded-form">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={receiptNotRequired}
                  disabled={receiptBusy || busy || review?.advancing}
                  onChange={(e) =>
                    void updateReceiptRequirement(e.target.checked)
                  }
                />
                Receipt not required
              </label>
              <p className="form-help">
                Exclude this payment from receipt coverage and the missing
                receipts list. This choice is saved immediately.
              </p>
              <SimilarReceiptRequirements
                entry={data}
                context={ctx}
                disabled={receiptBusy || busy || Boolean(review?.advancing)}
              />
            </div>
          )}
          {data.receipts?.length ? (
            <div className="linked-list">
              {data.receipts.map((receipt) => (
                <button
                  key={receipt.id}
                  onClick={() =>
                    ctx.navigate(
                      `/receipts/${receipt.id}${review ? `?returnTo=${encodeURIComponent(review.returnTo)}&transaction=${encodeURIComponent(id)}` : ""}`,
                    )
                  }
                >
                  <ReceiptText size={21} />
                  <div>
                    <strong>{receipt.merchant || receipt.filename}</strong>
                    <small>{receipt.filename}</small>
                  </div>
                  <ExternalLink size={15} />
                </button>
              ))}
            </div>
          ) : (
            <Empty
              title={
                receiptNotRequired
                  ? "Receipt not required"
                  : "No receipt linked"
              }
              text={
                receiptNotRequired
                  ? "This payment is excluded from receipt coverage. You can still attach a receipt if you find one."
                  : "Upload the retailer receipt to split this payment into product categories."
              }
            >
              <button
                className="button secondary"
                onClick={() =>
                  ctx.navigate(
                    review
                      ? `/receipts?returnTo=${encodeURIComponent(review.returnTo)}&transaction=${id}`
                      : "/receipts",
                  )
                }
              >
                <Upload size={16} />
                Import receipt
              </button>
            </Empty>
          )}
          {review &&
          data.receipts?.length &&
          !receiptComplete &&
          !receiptNotRequired ? (
            <div className="padded-form">
              <button
                className="button secondary"
                onClick={() =>
                  ctx.navigate(
                    `/receipts?returnTo=${encodeURIComponent(review.returnTo)}&transaction=${encodeURIComponent(id)}`,
                  )
                }
              >
                <Upload size={16} />
                Import or link another receipt
              </button>
            </div>
          ) : null}
          {data.source === "bank" && (
            <details className="source-details">
              <summary>Original bank data</summary>
              <pre>{JSON.stringify(data.raw, null, 2)}</pre>
            </details>
          )}
        </aside>
      </div>
    </div>
  );
}
export function ReceiptsView({ context: ctx }: { context: AppContext }) {
  const searchParams = useSearchParams();
  const requestedReturn = searchParams.get("returnTo") || "";
  const reviewReturn = /^\/review(?:\?|$)/.test(requestedReturn)
    ? requestedReturn
    : null;
  const filter = searchParams.get("retailer") || "",
    page = Math.max(1, Math.floor(Number(searchParams.get("page")) || 1));
  const params = new URLSearchParams({
    page: String(page),
    ...(filter ? { retailer: filter } : {}),
  });
  const { data, error, loading } = useData<{
    rows: Receipt[];
    count: number;
    page: number;
    limit: number;
  }>(`receipts?${params}`, ctx.revision, 5000);
  const [files, setFiles] = useState<File[]>([]),
    [retailer, setRetailer] = useState("unknown"),
    [busy, setBusy] = useState(false),
    [uploadError, setUploadError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const upload = async () => {
    setBusy(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.set("retailer", retailer);
      files.forEach((file) => form.append("files", file));
      const result = await api<{
        results: Array<{
          filename: string;
          error?: string;
          duplicate?: boolean;
        }>;
      }>("receipts/upload", form);
      const errors = result.results.filter((r) => r.error);
      if (errors.length)
        setUploadError(
          errors.map((r) => `${r.filename}: ${r.error}`).join(" "),
        );
      if (result.results.length > errors.length) {
        ctx.notify(
          `${result.results.length - errors.length} files received. Receipts are being processed.`,
        );
        setFiles([]);
        ctx.refresh();
      }
    } catch (e) {
      setUploadError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const receipts = data?.rows || [];
  return (
    <div className="view-stack">
      {reviewReturn && (
        <TextLink onClick={() => ctx.navigate(reviewReturn)}>
          <ArrowLeft size={15} />
          Back to review
        </TextLink>
      )}
      <section
        className="upload-panel"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (!busy) setFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <div className="upload-icon">
          <Upload size={26} strokeWidth={1.5} />
        </div>
        <div>
          <h2>Import receipts</h2>
          <p>
            Drop your receipts here or choose files. PDF, PNG, JPEG, CSV, TXT,
            forwarded EML emails, and Amazon invoice packs.
          </p>
          <small>
            Up to 20 files · 15 MB per receipt · 20 MB per email · 70 MB per
            Amazon pack
          </small>
        </div>
        <div className="upload-actions">
          <input
            ref={input}
            type="file"
            multiple
            accept=".pdf,.png,.jpg,.jpeg,.csv,.txt,.eml,.amazon.json"
            className="visually-hidden"
            aria-label="Receipt files"
            onChange={(e) => setFiles(Array.from(e.target.files || []))}
          />
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            Choose files
          </button>
          <select
            aria-label="Receipt retailer"
            value={retailer}
            onChange={(e) => setRetailer(e.target.value)}
          >
            <option value="unknown">Detect retailer</option>
            <option value="rimi">Rimi</option>
            <option value="partnerkaart">Partnerkaart</option>
            <option value="coop">Coop</option>
            <option value="maxima">Maxima</option>
            <option value="lidl">Lidl</option>
            <option value="wolt">Wolt</option>
            <option value="amazon">Amazon.de</option>
          </select>
        </div>
      </section>
      {files.length > 0 && (
        <div className="selected-files">
          <div>
            <strong>{files.length} files selected</strong>
            <span>{files.map((f) => f.name).join(", ")}</span>
          </div>
          <button className="button primary" disabled={busy} onClick={upload}>
            {busy ? "Uploading…" : "Import receipts"}
            <Upload size={16} />
          </button>
        </div>
      )}
      <ErrorMessage message={uploadError || error} />
      <section className="panel">
        <SectionTitle
          title="Imported receipts"
          action={
            <select
              aria-label="Filter retailer"
              value={filter}
              onChange={(e) => updateQuery({ retailer: e.target.value }, true)}
            >
              <option value="">All retailers</option>
              <option value="rimi">Rimi</option>
              <option value="partnerkaart">Partnerkaart</option>
              <option value="coop">Coop</option>
              <option value="maxima">Maxima</option>
              <option value="lidl">Lidl</option>
              <option value="wolt">Wolt</option>
              <option value="amazon">Amazon.de</option>
              <option value="unknown">Other</option>
            </select>
          }
        />
        {!data && loading ? (
          <Loading />
        ) : receipts.length ? (
          <ReceiptTable
            receipts={receipts}
            context={ctx}
            returnTo={reviewReturn || `/receipts?${searchParams}`}
            transactionId={
              reviewReturn
                ? searchParams.get("transaction") || undefined
                : undefined
            }
          />
        ) : (
          <Empty
            title="No matching receipts"
            text="Import receipt files or select another retailer."
          />
        )}
        {data && (
          <div className="pagination">
            <span>
              {data.count
                ? `${(data.page - 1) * data.limit + 1}–${Math.min(data.page * data.limit, data.count)} of ${data.count}`
                : "0 receipts"}
            </span>
            <div>
              <button
                className="icon-button"
                aria-label="Previous page"
                disabled={data.page === 1}
                onClick={() => updateQuery({ page: String(data.page - 1) })}
              >
                <ChevronLeft size={18} />
              </button>
              <span>Page {data.page}</span>
              <button
                className="icon-button"
                aria-label="Next page"
                disabled={data.page * data.limit >= data.count}
                onClick={() => updateQuery({ page: String(data.page + 1) })}
              >
                <ChevronRight size={18} />
              </button>
            </div>
          </div>
        )}
      </section>
      <div className="notice subtle">
        <ReceiptText size={18} />
        <span>
          Linked receipts do not add to spending. Record a cash payment to count
          an unlinked receipt as an expense.
        </span>
      </div>
    </div>
  );
}
function ReceiptTable({
  receipts,
  context: ctx,
  returnTo,
  transactionId,
}: {
  receipts: Receipt[];
  context: AppContext;
  returnTo?: string;
  transactionId?: string;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Receipt</th>
            <th>Purchase date</th>
            <th>Products</th>
            <th>Status</th>
            <th className="right">Total</th>
          </tr>
        </thead>
        <tbody>
          {receipts.map((receipt) => (
            <tr key={receipt.id}>
              <td>
                <button
                  className="merchant-link"
                  onClick={() =>
                    ctx.navigate(
                      `/receipts/${receipt.id}${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}${transactionId ? `&transaction=${transactionId}` : ""}` : ""}`,
                    )
                  }
                >
                  <span
                    className={`merchant-avatar retailer-${receipt.retailer}`}
                  >
                    <ReceiptText size={18} />
                  </span>
                  <span>
                    <strong>{receipt.merchant || receipt.filename}</strong>
                    <small>{receipt.filename}</small>
                  </span>
                </button>
              </td>
              <td className="nowrap">
                {receipt.purchased_at
                  ? shortDate(receipt.purchased_at)
                  : "To review"}
              </td>
              <td>{receipt.item_count || "—"}</td>
              <td>
                <ReceiptStatus receipt={receipt} />
              </td>
              <td className="right amount">
                {receipt.total === null
                  ? "—"
                  : formatMoney(receipt.total, receipt.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function ReceiptStatus({ receipt }: { receipt: Receipt }) {
  const label =
    receipt.status === "matched"
      ? receipt.linked_amount < Math.abs(receipt.total || 0)
        ? "Partially linked"
        : "Linked"
      : receipt.status === "ready"
        ? "Ready to link"
        : receipt.status === "review"
          ? "Needs review"
          : "Processing";
  return (
    <Badge
      variant={
        label === "Linked"
          ? "success"
          : ["Needs review", "Partially linked"].includes(label)
            ? "warning"
            : "neutral"
      }
    >
      {label}
    </Badge>
  );
}
type Draft = {
  merchant: string;
  retailer: string;
  purchased_at: string;
  receipt_number: string;
  currency: string;
  total: string;
  items: Array<{
    description: string;
    quantity: string | null;
    unit: string | null;
    amount: string;
    category_id: string;
  }>;
  remember: boolean;
};
export function ReceiptDetailView({
  context: ctx,
  id,
}: {
  context: AppContext;
  id: string;
}) {
  const searchParams = useSearchParams();
  const requestedReturn = searchParams.get("returnTo") || "";
  const returnTo = /^\/(?:receipts|review)(?:\?|$)/.test(requestedReturn)
    ? requestedReturn
    : "/receipts";
  const { data, error, loading } = useData<ReceiptDetail>(
    `receipts/${id}${searchParams.get("transaction") ? `?transaction=${encodeURIComponent(searchParams.get("transaction")!)}` : ""}`,
    ctx.revision,
    5000,
  );
  const [draft, setDraft] = useState<Draft | null>(null),
    [editing, setEditing] = useState(false),
    [saveError, setSaveError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [candidate, setCandidate] = useState(""),
    [linkAmount, setLinkAmount] = useState("");
  const selectedHint = useRef(false);
  useEffect(() => {
    if (!data || selectedHint.current) return;
    const target = data.candidates.find(
      (c) => c.id === searchParams.get("transaction"),
    );
    if (target) {
      const remaining =
        Math.abs(data.total || 0) -
        data.links.reduce((sum, link) => sum + link.amount, 0);
      setCandidate(target.id);
      setLinkAmount(
        decimalMoney(
          Math.min(remaining, target.available_amount),
          data.currency,
        ),
      );
      selectedHint.current = true;
    }
  }, [data, searchParams]);
  useEffect(() => {
    if (data && !editing)
      setDraft({
        merchant: data.merchant || "",
        retailer: data.retailer,
        purchased_at: data.purchased_at || "",
        receipt_number: data.receipt_number || "",
        currency: data.currency,
        total: decimalMoney(data.total || 0, data.currency),
        items: data.items.map((item) => ({
          ...item,
          amount: decimalMoney(Number(item.amount), data.currency),
        })),
        remember: false,
      });
  }, [data, editing]);
  if (!data || !draft)
    return (
      <>
        <ErrorMessage message={error} />
        {loading && <Loading />}
      </>
    );
  const fmt = (value: number) => formatMoney(value, data.currency),
    paid = data.links.reduce((sum, link) => sum + link.amount, 0),
    remaining = Math.abs(data.total || 0) - paid;
  const perform = async (path: string, body?: unknown, method?: string) => {
    setBusy(true);
    setSaveError(null);
    try {
      await api(path, body, method);
      ctx.refresh();
      ctx.notify("Receipt updated.");
      return true;
    } catch (e) {
      setSaveError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await perform(`receipts/${id}`, draft)) setEditing(false);
  };
  const change = (field: keyof Draft, value: unknown) =>
    setDraft((d) => (d ? { ...d, [field]: value } : d));
  const changeItem = (index: number, field: string, value: string) =>
    setDraft((d) =>
      d
        ? {
            ...d,
            items: d.items.map((item, i) =>
              i === index ? { ...item, [field]: value } : item,
            ),
          }
        : d,
    );
  let lineTotal: number | null = null;
  try {
    lineTotal = draft.items.reduce(
      (sum, item) => sum + parseMoney(item.amount, draft.currency),
      0,
    );
  } catch {
    /* Display an invalid amount notice until corrected. */
  }
  return (
    <div className="view-stack">
      <TextLink onClick={() => ctx.navigate(returnTo)}>
        <ArrowLeft size={15} />
        {returnTo.startsWith("/review") ? "Back to review" : "All receipts"}
      </TextLink>
      <ErrorMessage message={error || saveError || data.error} />
      {data.issues.length > 0 && (
        <div className="notice warning">
          <div>
            <strong>A quick review is needed</strong>
            {data.issues.map((issue) => (
              <p key={issue}>{issue}</p>
            ))}
          </div>
        </div>
      )}
      <div className="detail-grid">
        <section className="panel">
          <SectionTitle
            title={data.merchant || data.filename}
            description={data.filename}
            action={
              <div className="button-row">
                <ReceiptStatus receipt={{ ...data, linked_amount: paid }} />
                <button
                  className="button secondary"
                  onClick={() => setEditing(!editing)}
                >
                  {editing ? "Cancel editing" : "Edit receipt"}
                </button>
              </div>
            }
          />
          <form onSubmit={save} className="padded-form receipt-form">
            {editing ? (
              <>
                <div className="form-grid">
                  <label>
                    Merchant
                    <input
                      value={draft.merchant}
                      onChange={(e) => change("merchant", e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    Retailer
                    <select
                      value={draft.retailer}
                      onChange={(e) => change("retailer", e.target.value)}
                    >
                      <option value="unknown">Other</option>
                      <option value="rimi">Rimi</option>
                      <option value="partnerkaart">Partnerkaart</option>
                      <option value="coop">Coop</option>
                      <option value="maxima">Maxima</option>
                      <option value="lidl">Lidl</option>
                      <option value="wolt">Wolt</option>
                      <option value="amazon">Amazon.de</option>
                    </select>
                  </label>
                  <label>
                    Purchase date
                    <ISODateInput
                      value={draft.purchased_at}
                      onChange={(e) => change("purchased_at", e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    Receipt number
                    <input
                      value={draft.receipt_number}
                      onChange={(e) => change("receipt_number", e.target.value)}
                    />
                  </label>
                  <label>
                    Total
                    <input
                      inputMode="decimal"
                      value={draft.total}
                      onChange={(e) => change("total", e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    Currency
                    <input
                      value={draft.currency}
                      onChange={(e) =>
                        change("currency", e.target.value.toUpperCase())
                      }
                      maxLength={3}
                      pattern="[A-Z]{3}"
                      required
                    />
                  </label>
                </div>
                <SectionTitle
                  title="Products and adjustments"
                  description="Include discounts as negative amounts. The lines must reconcile exactly."
                />
                <div className="receipt-edit-items">
                  {draft.items.map((item, i) => (
                    <div className="receipt-edit-item" key={i}>
                      <input
                        aria-label={`Product ${i + 1}`}
                        value={item.description}
                        onChange={(e) =>
                          changeItem(i, "description", e.target.value)
                        }
                        placeholder="Product or discount"
                        required
                      />
                      <input
                        aria-label={`Product amount ${i + 1}`}
                        inputMode="decimal"
                        value={item.amount}
                        onChange={(e) =>
                          changeItem(i, "amount", e.target.value)
                        }
                        required
                      />
                      <select
                        aria-label={`Product category ${i + 1}`}
                        value={item.category_id}
                        onChange={(e) =>
                          changeItem(i, "category_id", e.target.value)
                        }
                      >
                        {ctx.state.categories
                          .filter(
                            (c) => !["investments", "pension"].includes(c.id),
                          )
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                      </select>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove product ${i + 1}`}
                        onClick={() =>
                          change(
                            "items",
                            draft.items.filter((_, n) => n !== i),
                          )
                        }
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="allocation-footer">
                  <button
                    type="button"
                    className="text-link"
                    onClick={() =>
                      change("items", [
                        ...draft.items,
                        {
                          description: "",
                          amount: "0.00",
                          category_id: "uncategorized",
                          quantity: null,
                          unit: null,
                        },
                      ])
                    }
                  >
                    <Plus size={15} />
                    Add product
                  </button>
                  <strong>
                    Line total:{" "}
                    {lineTotal === null
                      ? "Check amounts"
                      : formatMoney(lineTotal, draft.currency)}
                  </strong>
                </div>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={draft.remember}
                    onChange={(e) => change("remember", e.target.checked)}
                  />
                  Remember these product categories for future receipts
                </label>
                <button className="button primary" disabled={busy}>
                  {busy ? "Saving…" : "Save and validate"}
                </button>
              </>
            ) : (
              <>
                <div className="detail-facts">
                  <div>
                    <span>Purchase date</span>
                    <strong>
                      {data.purchased_at
                        ? shortDate(data.purchased_at)
                        : "Missing"}
                    </strong>
                  </div>
                  <div>
                    <span>Total</span>
                    <strong>
                      {data.total === null ? "Missing" : fmt(data.total)}
                    </strong>
                  </div>
                  <div>
                    <span>Receipt number</span>
                    <strong>{data.receipt_number || "Not found"}</strong>
                  </div>
                </div>
                {data.items.length ? (
                  <div className="table-wrap">
                    <table className="product-table">
                      <thead>
                        <tr>
                          <th>Product</th>
                          <th>Category</th>
                          <th className="right">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.items.map((item, i) => (
                          <tr key={i}>
                            <td>
                              <strong>{item.description}</strong>
                              {item.quantity && (
                                <small>
                                  {item.quantity} {item.unit}
                                </small>
                              )}
                            </td>
                            <td>
                              <Badge
                                variant={
                                  item.category_id === "uncategorized"
                                    ? "warning"
                                    : "neutral"
                                }
                              >
                                {
                                  ctx.state.categories.find(
                                    (c) => c.id === item.category_id,
                                  )?.name
                                }
                              </Badge>
                            </td>
                            <td className="right amount">{fmt(item.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty
                    title="Receipt details missing"
                    text="Open the original receipt, then edit the date, total, and product lines."
                  />
                )}
              </>
            )}
          </form>
          <details className="source-details">
            <summary>Extracted receipt text</summary>
            <pre>{data.text || "No text was extracted."}</pre>
          </details>
        </section>
        <aside className="view-stack">
          <section className="panel">
            <SectionTitle title="Link payment" />
            <div className="padded-form">
              {data.links.map((link) => (
                <div className="payment-link" key={link.transaction_id}>
                  <button
                    className="text-link"
                    onClick={() =>
                      ctx.navigate(`/transactions/${link.transaction_id}`)
                    }
                  >
                    {link.merchant === "Bank transaction" && link.description
                      ? link.description
                      : link.merchant}
                  </button>
                  {link.status === "PDNG" && (
                    <Badge variant="warning">Pending bank payment</Badge>
                  )}
                  <small>
                    {shortDate(link.booked_at)} · {link.account_name}
                  </small>
                  <div>
                    <strong>{fmt(link.amount)}</strong>
                    <button
                      className="text-link danger-text"
                      disabled={busy}
                      onClick={async () => {
                        if (link.source === "cash") {
                          if (
                            confirm("Remove this cash expense from the ledger?")
                          )
                            await perform(
                              `transactions/${link.transaction_id}`,
                              undefined,
                              "DELETE",
                            );
                        } else
                          await perform(`receipts/${id}/unlink`, {
                            transactionId: link.transaction_id,
                          });
                      }}
                    >
                      {link.source === "cash" ? "Remove cash entry" : "Unlink"}
                    </button>
                  </div>
                </div>
              ))}
              {remaining > 0 && ["ready", "matched"].includes(data.status) ? (
                <>
                  <p className="muted small">
                    {fmt(remaining)} still to link. For a split payment, choose
                    the amount paid by each account.
                  </p>
                  <label>
                    Bank payment
                    <select
                      value={candidate}
                      onChange={(e) => {
                        setCandidate(e.target.value);
                        const item = data.candidates.find(
                          (c) => c.id === e.target.value,
                        );
                        setLinkAmount(
                          item
                            ? decimalMoney(
                                Math.min(remaining, item.available_amount),
                                data.currency,
                              )
                            : "",
                        );
                      }}
                    >
                      <option value="">Choose a payment…</option>
                      {data.candidates.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.merchant === "Bank transaction" && c.description
                            ? c.description
                            : c.merchant}
                          {c.status === "PDNG" ? " · Pending" : ""} ·{" "}
                          {shortDate(c.booked_at)} · {fmt(Math.abs(c.amount))} ·{" "}
                          {c.account_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {data.candidates.some((c) => c.status === "PDNG") && (
                    <p className="muted small">
                      Pending payments can be linked now. They enter spending
                      totals when the bank books them.
                    </p>
                  )}
                  <label>
                    Amount to link
                    <input
                      inputMode="decimal"
                      value={linkAmount}
                      onChange={(e) => setLinkAmount(e.target.value)}
                      placeholder={decimalMoney(remaining, data.currency)}
                    />
                  </label>
                  <button
                    className="button primary wide"
                    disabled={!candidate || busy}
                    onClick={() =>
                      perform(`receipts/${id}/link`, {
                        transactionId: candidate,
                        amount: linkAmount,
                      })
                    }
                  >
                    <Link2 size={16} />
                    Link payment
                  </button>
                  <div className="or-divider">or, if paid in cash</div>
                  <button
                    className="button secondary wide"
                    disabled={busy}
                    onClick={() => {
                      if (
                        confirm(
                          `Record the remaining ${fmt(remaining)} as a cash purchase?`,
                        )
                      )
                        void perform(`receipts/${id}/cash`, {});
                    }}
                  >
                    <WalletCards size={16} />
                    Record cash payment
                  </button>
                </>
              ) : remaining <= 0 && data.links.length ? (
                <div
                  className={`notice ${data.links.some((link) => link.status === "PDNG") ? "warning" : "success"}`}
                >
                  {data.links.some((link) => link.status === "PDNG") ? (
                    <Clock3 size={18} />
                  ) : (
                    <CheckCheck size={18} />
                  )}
                  {data.links.some((link) => link.status === "PDNG")
                    ? "Receipt linked. Waiting for the bank to book the pending payment."
                    : "This receipt is fully accounted for."}
                </div>
              ) : (
                <div className="notice">
                  Review and validate the receipt before linking a payment.
                </div>
              )}
            </div>
          </section>
          <section className="panel">
            <SectionTitle title="Original receipt" />
            <div className="padded-form">
              {data.content_type.startsWith("image/") && (
                <img
                  className="receipt-preview"
                  src={`/api/receipts/${id}/file`}
                  alt="Original receipt"
                />
              )}
              <a
                className="button secondary wide"
                href={`/api/receipts/${id}/file`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink size={16} />
                Open original
              </a>
              {!data.manual && (
                <button
                  className="text-link"
                  disabled={busy || data.status === "processing"}
                  onClick={() => perform(`receipts/${id}/retry`, {})}
                >
                  <RefreshCw size={14} />
                  Retry extraction
                </button>
              )}
              <small className="muted">
                Imported {dateTime(data.created_at)} · {data.source}
              </small>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
export function ImportReviewView({ context: ctx }: { context: AppContext }) {
  const { data, error, loading } = useData<{
    transactions: Entry[];
    receipts: Receipt[];
    emails: Array<{
      id: string;
      subject: string | null;
      error: string;
      sender: string | null;
    }>;
  }>("review", ctx.revision, 10000);
  if (!data)
    return (
      <>
        <ErrorMessage message={error} />
        {loading && <Loading />}
      </>
    );
  return (
    <div className="view-stack">
      <ErrorMessage message={error} />
      {!data.receipts.length && !data.emails.length && (
        <section className="panel">
          <Empty
            title="Nothing to review"
            text="Unlinked receipts and failed email imports appear here."
          />
        </section>
      )}
      {data.receipts.length > 0 && (
        <section className="panel">
          <SectionTitle
            title="Receipts to review or link"
            description="Validate amounts and connect each receipt to its payment."
          />
          <ReceiptTable receipts={data.receipts} context={ctx} />
        </section>
      )}
      {data.emails.length > 0 && (
        <section className="panel">
          <SectionTitle title="Email imports to review" />
          {data.emails.map((email) => (
            <div key={email.id} className="email-review">
              <div>
                <strong>{email.subject || "Receipt email"}</strong>
                <p>{email.error}</p>
              </div>
              <a
                className="button secondary"
                href={`/api/emails/${email.id}/file`}
              >
                Download email
              </a>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function SimilarReceiptRequirements({
  entry,
  context: ctx,
  disabled,
}: {
  entry: Entry;
  context: AppContext;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pattern, setPattern] = useState("");
  const [value, setValue] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setOpen(false);
    setPattern(suggestedDescriptionPattern(entry.description));
    setValue(true);
    setError(null);
  }, [entry.id, entry.description]);
  const preview = useData<{
    count: number;
    examples: Array<{
      id: string;
      description: string;
      booked_at: string;
      amount: number;
      currency: string;
    }>;
  }>(
    open
      ? `transactions/${entry.id}/similar?${new URLSearchParams({
          purpose: "receipt",
          pattern,
          receiptNotRequired: String(value),
        })}`
      : null,
    ctx.revision,
  );
  const count =
    (preview.data?.count || 0) + Number(entry.receipt_not_required !== value);
  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ count: number }>(
        `transactions/${entry.id}/receipt-requirement`,
        {
          receiptNotRequired: value,
          similarPattern: pattern,
        },
      );
      ctx.notify(
        `${result.count} transactions marked receipt ${value ? "not required" : "required"}.`,
      );
      ctx.refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!entry.merchant.trim()) return null;
  return (
    <div className="view-stack">
      <label className="checkbox">
        <input
          type="checkbox"
          checked={open}
          disabled={disabled || busy}
          onChange={(e) => setOpen(e.target.checked)}
        />
        Update receipt requirement for similar transactions
      </label>
      {open && (
        <>
          <label>
            Receipt requirement
            <select
              value={String(value)}
              disabled={disabled || busy}
              onChange={(e) => setValue(e.target.value === "true")}
            >
              <option value="true">Receipt not required</option>
              <option value="false">Receipt required</option>
            </select>
          </label>
          <label>
            Receipt description contains
            <input
              value={pattern}
              maxLength={200}
              disabled={disabled || busy}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="Leave blank for all payments to this merchant"
            />
          </label>
          <p className="form-help">
            Same merchant ({entry.merchant}), payment type and currency, across
            all history. Receipt-linked payments are skipped. Categories,
            amounts and notes are kept.
          </p>
          <ErrorMessage message={error || preview.error} />
          {preview.loading ? (
            <Loading />
          ) : (
            preview.data && (
              <div aria-live="polite">
                <p>
                  {preview.data.count} other matching transactions will change.
                </p>
                {preview.data.examples.map((row) => (
                  <p className="form-help" key={row.id}>
                    {shortDate(row.booked_at)} ·{" "}
                    {row.description || entry.merchant} ·{" "}
                    {formatMoney(row.amount, row.currency)}
                  </p>
                ))}
              </div>
            )
          )}
          <button
            className="button secondary"
            disabled={
              disabled ||
              busy ||
              preview.loading ||
              Boolean(preview.error) ||
              !preview.data ||
              !count
            }
            onClick={() => void apply()}
          >
            {busy
              ? "Updating…"
              : `Mark ${count} transactions receipt ${value ? "not required" : "required"}`}
          </button>
        </>
      )}
    </div>
  );
}
