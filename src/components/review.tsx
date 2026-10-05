"use client";
import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Play } from "lucide-react";
import {
  api,
  useData,
  updateQuery,
  Loading,
  ErrorMessage,
  Empty,
  SectionTitle,
  TextLink,
  shortDate,
  type AppContext,
} from "./ui";
import { TransactionDetailView, ImportReviewView } from "./records";

type Queue = { ids: string[] };
function monthDates(month: string) {
  const [year, number] = month.split("-").map(Number);
  return {
    from: `${month}-01`,
    to: new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10),
  };
}

export function ReviewView({ context: ctx }: { context: AppContext }) {
  const params = useSearchParams();
  const defaults = monthDates(ctx.month);
  const [from, setFrom] = useState(params.get("from") || defaults.from);
  const [to, setTo] = useState(params.get("to") || defaults.to);
  const [currency, setCurrency] = useState(
    params.get("currency") ?? ctx.currency,
  );
  const [reviewed, setReviewed] = useState<string[]>([]);
  const [advancing, setAdvancing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const active = params.get("run") === "true";
  const imports = params.get("tab") === "imports";
  const period = active
    ? {
        from: params.get("from") || from,
        to: params.get("to") || to,
        currency: params.get("currency") || "",
      }
    : { from, to, currency };
  const validPeriod =
    /^\d{4}-\d{2}-\d{2}$/.test(period.from) &&
    /^\d{4}-\d{2}-\d{2}$/.test(period.to) &&
    period.from <= period.to;
  const queuePath = `review/transactions?${new URLSearchParams(period)}`;
  const queue = useData<Queue>(
    !imports && validPeriod ? queuePath : null,
    ctx.revision,
  );
  const storageKey = `expenses-review:${period.from}:${period.to}:${period.currency}`;
  const current = params.get("transaction");
  const finished = params.get("finished") === "true";
  const reviewUrl = `/review?${params}`;

  useEffect(() => {
    if (!active) return;
    try {
      const saved: unknown = JSON.parse(
        sessionStorage.getItem(storageKey) || "[]",
      );
      setReviewed(
        Array.isArray(saved)
          ? saved.filter((id): id is string => typeof id === "string")
          : [],
      );
    } catch {
      setReviewed([]);
    }
  }, [active, storageKey]);

  useEffect(() => {
    if (
      !active ||
      imports ||
      current ||
      finished ||
      !queue.data ||
      queue.loading
    )
      return;
    const next = queue.data.ids.find((id) => !reviewed.includes(id));
    updateQuery({ transaction: next || null, finished: next ? null : "true" });
  }, [active, imports, current, finished, queue.data, queue.loading, reviewed]);

  const start = (event?: FormEvent) => {
    event?.preventDefault();
    setActionError(null);
    setReviewed([]);
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* Reviewing also works without storage. */
    }
    updateQuery({ ...period, run: "true", transaction: null, finished: null });
  };
  const changePeriod = () => {
    setFrom(period.from);
    setTo(period.to);
    setCurrency(period.currency);
    updateQuery({ run: null, transaction: null, finished: null });
  };
  const advance = async () => {
    if (!current || advancing) return;
    setAdvancing(true);
    setActionError(null);
    try {
      // Re-read after saving: a bulk category correction may resolve several
      // later payments, which should disappear from this pass immediately.
      const fresh = await api<Queue>(queuePath);
      const visited = [...new Set([...reviewed, current])];
      setReviewed(visited);
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(visited));
      } catch {
        /* Optional session persistence. */
      }
      const next = fresh.ids.find((id) => !visited.includes(id));
      updateQuery({
        transaction: next || null,
        finished: next ? null : "true",
      });
      ctx.refresh();
      window.scrollTo({ top: 0, behavior: "instant" });
    } catch (e) {
      setActionError((e as Error).message);
      throw e;
    } finally {
      setAdvancing(false);
    }
  };

  return (
    <div className="view-stack">
      {!active && (
        <div className="tabs">
          <button
            className={!imports ? "selected" : ""}
            onClick={() => updateQuery({ tab: null })}
          >
            Transactions
          </button>
          <button
            className={imports ? "selected" : ""}
            onClick={() => updateQuery({ tab: "imports" })}
          >
            Receipt & email imports
          </button>
        </div>
      )}
      {imports ? (
        <ImportReviewView context={ctx} />
      ) : (
        <>
          <ErrorMessage message={actionError || queue.error} />
          {!active ? (
            <section className="panel">
              <SectionTitle
                title="Review transactions"
                description="Choose a period and go through payments that still need a category or a receipt. Payments marked receipt not required are included only if their category still needs attention."
              />
              <form className="padded-form" onSubmit={start}>
                <div className="review-period">
                  <label>
                    From
                    <input
                      type="date"
                      value={from}
                      max={to || undefined}
                      required
                      onChange={(e) => setFrom(e.target.value)}
                    />
                  </label>
                  <label>
                    Through
                    <input
                      type="date"
                      value={to}
                      min={from || undefined}
                      required
                      onChange={(e) => setTo(e.target.value)}
                    />
                  </label>
                  <label>
                    Currency
                    <select
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value)}
                    >
                      <option value="">All currencies</option>
                      {ctx.state.currencies.map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {validPeriod && !queue.loading && queue.data && (
                  <p aria-live="polite">
                    {queue.data.ids.length} transactions need attention in this
                    period.
                  </p>
                )}
                <div className="button-row">
                  <button
                    className="button primary"
                    disabled={
                      !validPeriod || queue.loading || Boolean(queue.error)
                    }
                  >
                    <Play size={16} />
                    Start review
                  </button>
                </div>
              </form>
            </section>
          ) : (
            <>
              <section className="panel review-progress">
                <div>
                  <strong>
                    {shortDate(period.from)} – {shortDate(period.to)} ·{" "}
                    {period.currency || "All currencies"}
                  </strong>
                  <p className="form-help">
                    {reviewed.length} transactions reviewed in this pass
                    {queue.data
                      ? ` · ${queue.data.ids.length} still need attention`
                      : ""}
                  </p>
                </div>
                <TextLink onClick={changePeriod}>
                  <ArrowLeft size={15} />
                  Change period
                </TextLink>
              </section>
              {finished ? (
                queue.loading ? (
                  <Loading />
                ) : (
                  <section className="panel">
                    <Empty
                      title={
                        queue.data?.ids.length
                          ? "Review pass complete"
                          : "All caught up"
                      }
                      text={
                        queue.data?.ids.length
                          ? `${queue.data.ids.length} payments still need a category or receipt. Skipped payments remain available for another pass.`
                          : "Every payment in this period has a category and either a linked receipt or a receipt exemption."
                      }
                    >
                      {Boolean(queue.data?.ids.length) && (
                        <button
                          className="button primary"
                          onClick={() => start()}
                        >
                          <Play size={16} />
                          Review remaining transactions
                        </button>
                      )}
                      <button
                        className="button secondary"
                        onClick={changePeriod}
                      >
                        Choose another period
                      </button>
                    </Empty>
                  </section>
                )
              ) : current ? (
                <TransactionDetailView
                  key={current}
                  id={current}
                  context={ctx}
                  review={{ returnTo: reviewUrl, advancing, onNext: advance }}
                />
              ) : (
                <Loading />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
