"use client";
import { useState, type FormEvent } from "react";
import { ISODateInput } from "./iso-date-input";
import {
  api,
  useData,
  ErrorMessage,
  Loading,
  SectionTitle,
  type AppContext,
} from "./ui";
import { decimalMoney, formatMoney } from "../lib/money";

type LedgerAccount = {
  id: string;
  code: string;
  name: string;
  type: string;
  balance: number;
  opening_balance: number;
  opening_date: string | null;
  first_date: string | null;
};
type TrialBalance = {
  currency: string;
  debit: number;
  credit: number;
  accounts: LedgerAccount[];
};

export function TransactionJournal({
  id,
  currency,
  revision,
}: {
  id: string;
  currency: string;
  revision: number;
}) {
  const [open, setOpen] = useState(false);
  const report = useData<{
    journal: { id: string } | null;
    postings: { id: string; name: string; debit: number; credit: number }[];
  }>(open ? `accounting/transactions/${id}` : null, revision);
  return (
    <details
      className="source-details"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Journal postings</summary>
      <ErrorMessage message={report.error} />
      {open && report.loading && !report.data && <Loading />}
      {open &&
        report.data &&
        (report.data.journal ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Debit</th>
                  <th>Credit</th>
                </tr>
              </thead>
              <tbody>
                {report.data.postings.map((posting) => (
                  <tr key={posting.id}>
                    <td>{posting.name}</td>
                    <td>
                      {posting.debit
                        ? formatMoney(posting.debit, currency)
                        : "—"}
                    </td>
                    <td>
                      {posting.credit
                        ? formatMoney(posting.credit, currency)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>Journal postings appear when this transaction is booked.</p>
        ))}
    </details>
  );
}

function OpeningBalance({
  account,
  context: ctx,
}: {
  account: LedgerAccount;
  context: AppContext;
}) {
  const [amount, setAmount] = useState(
    decimalMoney(account.opening_balance, ctx.currency),
  );
  const [date, setDate] = useState(
    account.opening_date || account.first_date || `${ctx.month}-01`,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("accounting/opening-balance", {
        accountId: account.id,
        amount,
        date,
      });
      ctx.refresh();
      ctx.notify("Opening balance saved.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="padded-form" onSubmit={save}>
      <p>
        Balance for {account.name} at the beginning of this date, before
        imported activity. Enter 0 to remove it.
      </p>
      <label>
        Opening balance ({ctx.currency})
        <input
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          required
          disabled={busy}
        />
      </label>
      <label>
        Date
        <ISODateInput
          value={date}
          onChange={(event) => setDate(event.target.value)}
          required
          disabled={busy}
        />
      </label>
      <ErrorMessage message={error} />
      <button className="button primary" disabled={busy}>
        {busy ? "Saving…" : "Save opening balance"}
      </button>
    </form>
  );
}

export function AccountingPanel({ context: ctx }: { context: AppContext }) {
  const report = useData<TrialBalance>(
    `accounting/trial-balance?currency=${ctx.currency}`,
    ctx.revision,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const account = report.data?.accounts.find((item) => item.id === selected);
  const fmt = (amount: number) => formatMoney(amount, ctx.currency);
  return (
    <section className="panel">
      <SectionTitle
        title="Accounting"
        description={`All recorded history in ${ctx.currency}. Account balances start at zero unless you enter an opening balance.`}
      />
      <ErrorMessage message={report.error} />
      {report.loading && !report.data && <Loading />}
      {report.data && (
        <>
          <div className="padded-form">
            <p>
              Posted debits: {fmt(report.data.debit)} · Posted credits:{" "}
              {fmt(report.data.credit)}
            </p>
            <p className="muted">
              Transfer clearing holds movements whose other side has not offset
              them in this currency. Investment and pension balances use
              contributions and withdrawals, with no changes in value.
            </p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Type</th>
                  <th>Balance</th>
                  <th>Opening balance</th>
                </tr>
              </thead>
              <tbody>
                {report.data.accounts.map((item) => (
                  <tr key={item.id}>
                    <td>{item.name}</td>
                    <td>{item.type}</td>
                    <td>
                      {fmt(Math.abs(item.balance))}{" "}
                      {item.balance < 0 ? "Cr" : "Dr"}
                    </td>
                    <td>
                      {item.type === "asset" &&
                        !item.code.startsWith("transfers:") && (
                          <button
                            className="button secondary"
                            onClick={() =>
                              setSelected(selected === item.id ? null : item.id)
                            }
                          >
                            Edit opening balance
                          </button>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {account && (
            <OpeningBalance
              key={`${account.id}:${account.opening_balance}:${account.opening_date}`}
              account={account}
              context={ctx}
            />
          )}
        </>
      )}
    </section>
  );
}
