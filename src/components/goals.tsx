"use client";
import { useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { decimalMoney, parseMoney } from "../lib/money";
import { monthLabel } from "../lib/dates";
import {
  emptyPlan,
  type SpendingPlan,
  type FinancialOverview,
} from "../lib/spending-plan";
import {
  api,
  useData,
  Loading,
  ErrorMessage,
  SectionTitle,
  TextLink,
  type AppContext,
} from "./ui";
import { GoalProgress } from "./financial-overview";
import { ContributionHistory } from "./overview";
import { ISODateInput } from "./iso-date-input";

export function GoalsView({ context: ctx }: { context: AppContext }) {
  const { data, error, loading } = useData<FinancialOverview>(
    `financial-overview?month=${ctx.month}&currency=${ctx.currency}`,
    ctx.revision,
  );
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
      <div className="overview-context">
        <span>
          {monthLabel(ctx.month)} · {ctx.currency}
        </span>
        <TextLink onClick={() => ctx.navigate("/")}>Back to overview</TextLink>
      </div>
      <section className="panel">
        <SectionTitle
          title="Investment and pension goals"
          description="Progress uses net bank contributions, not portfolio values. Annual targets are shared across this year; monthly plans are saved separately."
        />
        <GoalProgress data={data} currency={ctx.currency} />
      </section>
      <PlanForm
        key={`${ctx.month}-${ctx.currency}`}
        context={ctx}
        initial={data.plan}
      />
      <ContributionHistory
        context={ctx}
        months={Number(ctx.month.slice(5, 7))}
      />
    </div>
  );
}

const moneyFields = [
  "income",
  "spendingLimit",
  "buffer",
  "investmentMonthly",
  "pensionMonthly",
  "investmentAnnual",
  "pensionAnnual",
  "cashBalance",
] as const;
type MoneyField = (typeof moneyFields)[number];
type Draft = Record<MoneyField, string> & {
  nextPayday: string;
  budgets: (Omit<SpendingPlan["budgets"][number], "amount"> & {
    amount: string;
  })[];
  bills: (Omit<SpendingPlan["bills"][number], "amount"> & { amount: string })[];
};
function draftFrom(plan: SpendingPlan, currency: string): Draft {
  const values = Object.fromEntries(
    moneyFields.map((field) => [
      field,
      plan[field] === null ? "" : decimalMoney(plan[field], currency),
    ]),
  ) as Record<MoneyField, string>;
  return {
    ...values,
    nextPayday: plan.nextPayday || "",
    budgets: plan.budgets.map((row) => ({
      ...row,
      amount: decimalMoney(row.amount, currency),
    })),
    bills: plan.bills.map((row) => ({
      ...row,
      amount: decimalMoney(row.amount, currency),
    })),
  };
}

function PlanForm({
  context: ctx,
  initial,
}: {
  context: AppContext;
  initial: SpendingPlan;
}) {
  const spendingCategories = ctx.state.categories.filter(
    (category) => !["investments", "pension"].includes(category.id),
  );
  const [draft, setDraft] = useState(() => draftFrom(initial, ctx.currency));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const update = (field: MoneyField | "nextPayday", value: string) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
    setMessage("");
  };
  const money = (value: string) => parseMoney(value || "0", ctx.currency);
  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage("");
    setBusy(true);
    try {
      const fields = Object.fromEntries(
        moneyFields.map((field) => [
          field,
          ["income", "spendingLimit", "cashBalance"].includes(field) &&
          draft[field].trim() === ""
            ? null
            : money(draft[field]),
        ]),
      ) as Pick<SpendingPlan, MoneyField>;
      const plan: SpendingPlan = {
        ...fields,
        nextPayday: draft.nextPayday || null,
        budgets: draft.budgets.map((row) => ({
          ...row,
          amount: money(row.amount),
        })),
        bills: draft.bills.map((row) => ({
          ...row,
          amount: money(row.amount),
        })),
      };
      await api("spending-plan", {
        month: ctx.month,
        currency: ctx.currency,
        plan,
      });
      setMessage(
        "Plan saved. Overview estimates and goal progress are updated.",
      );
      ctx.refresh();
      ctx.notify("Spending plan saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save your plan.");
    } finally {
      setBusy(false);
    }
  }
  async function copyPrevious() {
    setError(null);
    setMessage("");
    setBusy(true);
    try {
      const date = new Date(`${ctx.month}-01T12:00:00Z`);
      date.setUTCMonth(date.getUTCMonth() - 1);
      const result = await api<{ plan: SpendingPlan; saved: boolean }>(
        `spending-plan?month=${date.toISOString().slice(0, 7)}&currency=${ctx.currency}`,
      );
      if (!result.saved)
        throw new Error("No plan was saved for the previous month.");
      const plan = {
        ...emptyPlan(),
        ...result.plan,
        investmentAnnual: initial.investmentAnnual,
        pensionAnnual: initial.pensionAnnual,
        cashBalance: null,
        nextPayday: null,
        bills: result.plan.bills.map((bill) => ({
          ...bill,
          status: "unpaid" as const,
        })),
      };
      setDraft(draftFrom(plan, ctx.currency));
      setMessage(
        "Previous month copied. Check dates and amounts, then save this month’s plan.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not copy your plan.");
    } finally {
      setBusy(false);
    }
  }
  const field = (name: MoneyField, label: string, help?: string) => (
    <label>
      {label}
      <input
        aria-label={label}
        inputMode="decimal"
        value={draft[name]}
        onChange={(event) => update(name, event.target.value)}
        placeholder={
          name === "income" ||
          name === "spendingLimit" ||
          name === "cashBalance"
            ? "Optional"
            : "0.00"
        }
        disabled={busy}
      />
      {help && <small className="form-help">{help}</small>}
    </label>
  );
  return (
    <section className="panel">
      <SectionTitle
        title="Monthly spending plan"
        description={`${monthLabel(ctx.month)} · amounts in ${ctx.currency}. Only saved plans affect the overview.`}
        action={
          <button
            className="button subtle"
            type="button"
            disabled={busy}
            onClick={copyPrevious}
          >
            Copy previous month
          </button>
        }
      />
      <form className="spending-plan-form" onSubmit={save}>
        <ErrorMessage message={error} />
        {message && (
          <p className="notice" role="status">
            {message}
          </p>
        )}
        <fieldset disabled={busy}>
          <legend>Income and spending</legend>
          <div className="form-grid three">
            {field(
              "income",
              "Expected take-home income",
              "Total income for this month, including what you have already received.",
            )}
            {field(
              "spendingLimit",
              "Monthly living-expense limit",
              "Optional cap. The overview uses the lower of this cap and what income can support.",
            )}
            {field(
              "buffer",
              "Cash buffer",
              "Reserve this amount in addition to your contribution targets.",
            )}
          </div>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>Contribution targets</legend>
          <div className="form-grid">
            {field("investmentMonthly", "Monthly investment target")}
            {field("pensionMonthly", "Monthly pension target")}
            {field(
              "investmentAnnual",
              `Investment target for ${ctx.month.slice(0, 4)}`,
            )}
            {field(
              "pensionAnnual",
              `Pension target for ${ctx.month.slice(0, 4)}`,
            )}
          </div>
          <p className="form-help">
            The overview reserves the larger of your monthly target and the
            monthly pace needed to complete your annual target. Money returned
            reduces progress.
          </p>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>Category limits</legend>
          <p className="form-help">
            Mark categories flexible when their spending can be reduced. Fixed
            categories are not extrapolated at a daily pace.
          </p>
          <div className="plan-rows">
            {draft.budgets.map((row, index) => (
              <div className="budget-edit-row" key={index}>
                <label>
                  Category
                  <select
                    aria-label={`Budget category ${index + 1}`}
                    value={row.categoryId}
                    onChange={(event) =>
                      setDraft((previous) => ({
                        ...previous,
                        budgets: previous.budgets.map((item, i) =>
                          i === index
                            ? { ...item, categoryId: event.target.value }
                            : item,
                        ),
                      }))
                    }
                  >
                    {spendingCategories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Monthly limit
                  <input
                    aria-label={`Budget amount ${index + 1}`}
                    inputMode="decimal"
                    required
                    value={row.amount}
                    onChange={(event) =>
                      setDraft((previous) => ({
                        ...previous,
                        budgets: previous.budgets.map((item, i) =>
                          i === index
                            ? { ...item, amount: event.target.value }
                            : item,
                        ),
                      }))
                    }
                  />
                </label>
                <label className="plan-checkbox">
                  <input
                    type="checkbox"
                    checked={row.flexible}
                    onChange={(event) =>
                      setDraft((previous) => ({
                        ...previous,
                        budgets: previous.budgets.map((item, i) =>
                          i === index
                            ? { ...item, flexible: event.target.checked }
                            : item,
                        ),
                      }))
                    }
                  />
                  Flexible spending
                </label>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove budget ${index + 1}`}
                  onClick={() =>
                    setDraft((previous) => ({
                      ...previous,
                      budgets: previous.budgets.filter((_, i) => i !== index),
                    }))
                  }
                >
                  <Trash2 size={17} />
                </button>
              </div>
            ))}
          </div>
          <button
            className="button subtle"
            type="button"
            disabled={draft.budgets.length >= spendingCategories.length}
            onClick={() => {
              const category = spendingCategories.find(
                (category) =>
                  !draft.budgets.some((row) => row.categoryId === category.id),
              );
              if (category)
                setDraft((previous) => ({
                  ...previous,
                  budgets: [
                    ...previous.budgets,
                    { categoryId: category.id, amount: "", flexible: true },
                  ],
                }));
            }}
          >
            <Plus size={16} />
            Add category limit
          </button>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>Bills and recurring commitments</legend>
          <p className="form-help">
            Add bills you expect this month. Choose Booked or Pending only when
            the matching payment is already in the app. This avoids reserving it
            twice. Only booked bills are removed from the variable-spending
            pace. The checklist does not create transactions.
          </p>
          <div className="plan-rows">
            {draft.bills.map((bill, index) => {
              const change = (values: Partial<Draft["bills"][number]>) =>
                setDraft((previous) => ({
                  ...previous,
                  bills: previous.bills.map((item, i) =>
                    i === index ? { ...item, ...values } : item,
                  ),
                }));
              return (
                <div className="bill-edit-row" key={bill.id}>
                  <label>
                    Bill name
                    <input
                      required
                      maxLength={100}
                      aria-label={`Bill name ${index + 1}`}
                      value={bill.name}
                      onChange={(event) => change({ name: event.target.value })}
                    />
                  </label>
                  <label>
                    Amount
                    <input
                      required
                      inputMode="decimal"
                      aria-label={`Bill amount ${index + 1}`}
                      value={bill.amount}
                      onChange={(event) =>
                        change({ amount: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Due day
                    <input
                      type="number"
                      required
                      min={1}
                      max={31}
                      aria-label={`Bill due day ${index + 1}`}
                      value={bill.dueDay}
                      onChange={(event) =>
                        change({ dueDay: Number(event.target.value) })
                      }
                    />
                  </label>
                  <label>
                    Category
                    <select
                      aria-label={`Bill category ${index + 1}`}
                      value={bill.categoryId || ""}
                      onChange={(event) =>
                        change({ categoryId: event.target.value || null })
                      }
                    >
                      <option value="">Not assigned</option>
                      {spendingCategories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Payment status
                    <select
                      aria-label={`Bill status ${index + 1}`}
                      value={bill.status}
                      onChange={(event) =>
                        change({
                          status: event.target
                            .value as SpendingPlan["bills"][number]["status"],
                        })
                      }
                    >
                      <option value="unpaid">Unpaid</option>
                      <option value="pending">Pending in app</option>
                      <option value="paid">Booked in app</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove bill ${index + 1}`}
                    onClick={() =>
                      setDraft((previous) => ({
                        ...previous,
                        bills: previous.bills.filter(
                          (item) => item.id !== bill.id,
                        ),
                      }))
                    }
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              );
            })}
          </div>
          <button
            className="button subtle"
            type="button"
            onClick={() =>
              setDraft((previous) => ({
                ...previous,
                bills: [
                  ...previous.bills,
                  {
                    id: crypto.randomUUID(),
                    name: "",
                    amount: "",
                    dueDay: 1,
                    status: "unpaid" as const,
                    categoryId: null,
                  },
                ],
              }))
            }
          >
            <Plus size={16} />
            Add bill
          </button>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>Cash before payday</legend>
          <div className="form-grid">
            {field(
              "cashBalance",
              "Cash balance before pending payments",
              "Optional booked balance across cash and spending accounts. Update it as money moves; excludes investments.",
            )}
            <label>
              Next payday
              <ISODateInput
                value={draft.nextPayday}
                min={`${ctx.month}-01`}
                onChange={(event) => update("nextPayday", event.target.value)}
              />
            </label>
          </div>
          <p className="form-help">
            The cash check deducts outgoing pending payments, recorded bills due
            before payday, and your buffer. It checks current liquidity
            separately from this month’s spending allowance.
          </p>
        </fieldset>
        <div className="plan-save">
          <span className="muted small">
            Plans are saved per month and currency. Annual goals apply to the
            whole selected year.
          </span>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? "Saving…" : "Save spending plan"}
          </button>
        </div>
      </form>
    </section>
  );
}
