"use client";
import { useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import {
  Landmark,
  ArrowUpRight,
  RefreshCw,
  Link2,
  ShieldCheck,
  CheckCheck,
  Trash2,
  Plus,
  Eye,
  EyeOff,
  Copy,
  Mail,
  Activity,
} from "lucide-react";
import {
  api,
  useData,
  Loading,
  ErrorMessage,
  Empty,
  Badge,
  SectionTitle,
  dateTime,
  shortDate,
  initials,
  type AppContext,
  type Category,
} from "./ui";
import { formatMoney, parseMoney } from "../lib/money";
import type { EmailMessage } from "../lib/email-message";

type Bank = { name: string; country: string; maximum_consent_validity: number };
type Connection = {
  id: string;
  bank_name: string;
  country: string;
  status: string;
  valid_until: string;
  last_sync_at: string | null;
  last_error: string | null;
};
export function ConnectionsView({ context: ctx }: { context: AppContext }) {
  const search = useSearchParams();
  const [country, setCountry] = useState("EE"),
    [filter, setFilter] = useState(""),
    [busy, setBusy] = useState(""),
    [actionError, setActionError] = useState<string | null>(null);
  const banks = useData<Bank[]>(`banks?country=${country}`, ctx.revision),
    connections = useData<Connection[]>("connections", ctx.revision, 10000);
  const preferred = /lhv|seb|revolut/i;
  const options =
    banks.data
      ?.filter(
        (bank) =>
          !filter || bank.name.toLowerCase().includes(filter.toLowerCase()),
      )
      .sort(
        (a, b) =>
          Number(preferred.test(b.name)) - Number(preferred.test(a.name)) ||
          a.name.localeCompare(b.name),
      ) || [];
  const connect = async (bank: Bank) => {
    setBusy(bank.name);
    setActionError(null);
    try {
      const response = await api<{ url: string }>("connections/start", {
        bank: bank.name,
        country: bank.country,
      });
      window.location.assign(response.url);
    } catch (e) {
      setActionError((e as Error).message);
      setBusy("");
    }
  };
  const action = async (connection: Connection, disconnect = false) => {
    if (
      disconnect &&
      !confirm(
        `Stop synchronizing ${connection.bank_name}? Your imported data will remain available.`,
      )
    )
      return;
    setBusy(connection.id);
    setActionError(null);
    try {
      await api(
        disconnect
          ? `connections/${connection.id}`
          : `connections/${connection.id}/sync`,
        disconnect ? undefined : {},
        disconnect ? "DELETE" : "POST",
      );
      ctx.refresh();
      ctx.notify(disconnect ? "Bank disconnected." : "Synchronization queued.");
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="view-stack">
      <ErrorMessage
        message={
          actionError || search.get("error") || banks.error || connections.error
        }
      />
      {(connections.data?.length || 0) > 0 && (
        <section className="panel">
          <SectionTitle title="Connected banks" />
          <div className="connection-grid">
            {connections.data!.map((connection) => {
              const days = Math.ceil(
                (new Date(connection.valid_until).valueOf() - Date.now()) /
                  86400000,
              );
              return (
                <article key={connection.id} className="connection-card">
                  <div className="connection-top">
                    <span className="bank-symbol">
                      {initials(connection.bank_name)}
                    </span>
                    <div>
                      <h3>{connection.bank_name}</h3>
                      <span>{connection.country}</span>
                    </div>
                    <Badge
                      variant={
                        connection.status === "active" ? "success" : "warning"
                      }
                    >
                      {connection.status}
                    </Badge>
                  </div>
                  <div className="connection-facts">
                    <div>
                      <span>Last successful sync</span>
                      <strong>{dateTime(connection.last_sync_at)}</strong>
                    </div>
                    <div>
                      <span>Consent expires</span>
                      <strong>{shortDate(connection.valid_until)}</strong>
                    </div>
                  </div>
                  {days <= 10 && connection.status !== "disconnected" && (
                    <div className="notice warning">
                      {days <= 0
                        ? "Consent has expired. Reconnect to resume imports."
                        : `Renew your consent within ${days} days to keep imports running.`}
                    </div>
                  )}
                  {connection.last_error && (
                    <ErrorMessage message={connection.last_error} />
                  )}
                  <div className="button-row">
                    {connection.status === "active" ? (
                      <button
                        className="button secondary"
                        disabled={Boolean(busy)}
                        onClick={() => action(connection)}
                      >
                        <RefreshCw size={15} />
                        Refresh
                      </button>
                    ) : null}
                    <button
                      className="button primary"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        connect({
                          name: connection.bank_name,
                          country: connection.country,
                          maximum_consent_validity: 0,
                        })
                      }
                    >
                      <Link2 size={15} />
                      Reconnect
                    </button>
                    {connection.status !== "disconnected" && (
                      <button
                        className="icon-button"
                        aria-label={`Disconnect ${connection.bank_name}`}
                        disabled={Boolean(busy)}
                        onClick={() => action(connection, true)}
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}
      {ctx.state.accounts.some((a) => a.source === "bank") && (
        <section className="panel">
          <SectionTitle title="Accounts" />
          <div className="account-grid">
            {ctx.state.accounts
              .filter((a) => a.source === "bank")
              .map((account) => (
                <div className="account-card" key={account.id}>
                  <span className="account-bank">{account.bank_name}</span>
                  <h3>{account.name}</h3>
                  <p>
                    {account.iban
                      ? `•••• ${account.iban.slice(-4)}`
                      : "Linked bank account"}{" "}
                    · {account.currency || "Multiple currencies"}
                  </p>
                  {account.balance?.balances
                    ?.filter((b) =>
                      ["CLBD", "CLAV", "ITBD", "ITAV"].includes(b.balance_type),
                    )
                    .slice(0, 2)
                    .map((balance, i) => (
                      <strong key={i}>
                        {formatMoney(
                          parseMoney(
                            balance.balance_amount.amount,
                            balance.balance_amount.currency,
                          ),
                          balance.balance_amount.currency,
                        )}
                        <small>{balance.balance_type}</small>
                      </strong>
                    ))}
                  <small>
                    History:{" "}
                    {account.history_from
                      ? shortDate(account.history_from)
                      : "Not imported yet"}
                    {account.history_to
                      ? ` – ${shortDate(account.history_to)}`
                      : ""}
                  </small>
                </div>
              ))}
          </div>
        </section>
      )}
      <section className="panel">
        <SectionTitle
          title="Add a bank"
          action={
            <select
              aria-label="Bank country"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
            >
              <option value="EE">Estonia</option>
              <option value="LT">Lithuania · Revolut</option>
              <option value="LV">Latvia</option>
              <option value="FI">Finland</option>
              <option value="DE">Germany</option>
              <option value="IE">Ireland</option>
              <option value="FR">France</option>
              <option value="SE">Sweden</option>
              <option value="NL">Netherlands</option>
            </select>
          }
        />
        <div className="padded-form">
          <label>
            Find a bank
            <input
              placeholder="Search available banks…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </label>
        </div>
        {banks.loading && !banks.data ? (
          <Loading />
        ) : options.length ? (
          <div className="bank-grid">
            {options.map((bank) => (
              <button
                className="bank-option"
                disabled={Boolean(busy)}
                key={`${bank.country}:${bank.name}`}
                onClick={() => connect(bank)}
              >
                <span
                  className={`bank-symbol bank-${bank.name.toLowerCase().includes("seb") ? "seb" : bank.name.toLowerCase().includes("revolut") ? "revolut" : "other"}`}
                >
                  {initials(bank.name)}
                </span>
                <span>
                  <strong>{bank.name}</strong>
                  <small>{bank.country}</small>
                </span>
                <ArrowUpRight size={18} />
              </button>
            ))}
          </div>
        ) : (
          <Empty
            title="No banks found"
            text="Try another country or search. For Revolut, also check Lithuania."
          />
        )}
      </section>
    </div>
  );
}
type Rule = {
  id: string;
  field: string;
  pattern: string;
  category_id: string;
  category_name: string;
  priority: number;
  enabled: boolean;
};
export function RulesView({ context: ctx }: { context: AppContext }) {
  const rules = useData<Rule[]>("rules", ctx.revision),
    [field, setField] = useState("merchant"),
    [pattern, setPattern] = useState(""),
    [category, setCategory] = useState("groceries"),
    [priority, setPriority] = useState(100),
    [applyExisting, setApplyExisting] = useState(false),
    [preview, setPreview] = useState<{
      count: number;
      examples: string[];
    } | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const perform = async (fn: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (message) ctx.notify(message);
      ctx.refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (
      await perform(
        () =>
          api("rules", {
            field,
            pattern,
            category_id: category,
            priority,
            applyExisting,
          }),
        "Rule created.",
      )
    ) {
      setPattern("");
      setPreview(null);
    }
  };
  return (
    <div className="view-stack">
      <ErrorMessage message={error || rules.error} />
      <div className="notice subtle">
        <ShieldCheck size={18} />
        <span>
          Manual corrections take priority. Rules apply next, followed by
          receipt details and merchant suggestions.
        </span>
      </div>
      <div className="detail-grid">
        <section className="panel">
          <SectionTitle
            title="Saved rules"
            description="Lower priority numbers run first."
            action={
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  perform(
                    () => api("rules/apply", {}),
                    "Rules applied. Manual corrections were preserved.",
                  )
                }
              >
                <RefreshCw size={15} />
                Apply to history
              </button>
            }
          />
          {rules.data?.length ? (
            <div className="rule-list">
              {rules.data.map((rule) => (
                <div className="rule-row" key={rule.id}>
                  <div>
                    <strong>
                      {rule.field} contains “{rule.pattern}”
                    </strong>
                    <small>
                      {rule.category_name} · Priority {rule.priority}
                    </small>
                  </div>
                  <Badge variant={rule.enabled ? "success" : "neutral"}>
                    {rule.enabled ? "Enabled" : "Paused"}
                  </Badge>
                  <button
                    className="button secondary small-button"
                    disabled={busy}
                    onClick={() =>
                      perform(
                        () =>
                          api(`rules/${rule.id}`, {
                            enabled: !rule.enabled,
                            priority: rule.priority,
                          }),
                        "Rule updated.",
                      )
                    }
                  >
                    {rule.enabled ? "Pause" : "Enable"}
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Delete rule ${rule.pattern}`}
                    disabled={busy}
                    onClick={() => {
                      if (
                        confirm(
                          "Delete this rule and reclassify automatic entries?",
                        )
                      )
                        void perform(
                          () => api(`rules/${rule.id}`, undefined, "DELETE"),
                          "Rule deleted.",
                        );
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          ) : rules.loading ? (
            <Loading />
          ) : (
            <Empty
              title="No rules yet"
              text="Create a rule for a merchant, payment description, or receipt product. Corrections can also remember product categories."
            />
          )}
        </section>
        <section className="panel">
          <SectionTitle
            title="Create a rule"
            description="Match plain text, without complex expressions."
          />
          <form className="padded-form" onSubmit={save}>
            <label>
              Match against
              <select
                value={field}
                onChange={(e) => {
                  setField(e.target.value);
                  setPreview(null);
                }}
              >
                <option value="merchant">Merchant name</option>
                <option value="description">Payment description</option>
                <option value="product">Receipt product name</option>
              </select>
            </label>
            <label>
              Contains
              <input
                required
                value={pattern}
                onChange={(e) => {
                  setPattern(e.target.value);
                  setPreview(null);
                }}
                placeholder="For example, Netflix"
                maxLength={200}
              />
            </label>
            <label>
              Assign category
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {ctx.state.categories
                  .filter(
                    (c) =>
                      field !== "product" ||
                      !["investments", "pension"].includes(c.id),
                  )
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
              <span className="form-help">
                Investment transfers and pension contributions classify outgoing
                payments separately from spending.
              </span>
            </label>
            <label>
              Priority
              <input
                type="number"
                min={0}
                max={10000}
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={applyExisting}
                onChange={(e) => setApplyExisting(e.target.checked)}
              />
              Also apply to existing automatic entries
            </label>
            <button
              type="button"
              className="button secondary wide"
              disabled={!pattern || busy}
              onClick={() =>
                perform(async () => {
                  setPreview(await api("rules/preview", { field, pattern }));
                })
              }
            >
              Preview matches
            </button>
            {preview && (
              <div className="notice">
                <div>
                  <strong>{preview.count} existing matches</strong>
                  {preview.examples.map((example, i) => (
                    <p key={i}>{example}</p>
                  ))}
                </div>
              </div>
            )}
            <button className="button primary wide" disabled={busy}>
              <Plus size={16} />
              Create rule
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
type Settings = {
  appUrl: string;
  bankingRedirect: string;
  port: number;
  host: string;
  bankingConfigured: boolean;
  workerAt: string | null;
  inboundUrl: string;
  mailbox: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    folder: string;
    enabled: boolean;
    hasPassword: boolean;
    lastSyncAt?: string;
    error?: string;
  } | null;
};
export function SettingsView({ context: ctx }: { context: AppContext }) {
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
  const message = useData<EmailMessage>(
    selectedEmail ? `emails/${selectedEmail}` : null,
    ctx.revision,
  );
  const settings = useData<Settings>("settings", ctx.revision, 30000),
    emails = useData<
      Array<{
        id: string;
        subject: string;
        sender: string;
        status: string;
        error: string | null;
        received_at: string;
      }>
    >("emails", ctx.revision, 10000),
    imports = useData<
      Array<{
        id: string;
        type: string;
        status: string;
        count: number;
        error: string | null;
        started_at: string;
      }>
    >("imports", ctx.revision, 15000);
  const [token, setToken] = useState(""),
    [error, setError] = useState<string | null>(null),
    [check, setCheck] = useState<{
      active: boolean;
      environment: string;
    } | null>(null);
  const reveal = async () => {
    try {
      if (token) setToken("");
      else
        setToken(
          (await api<{ token: string }>("settings/inbound-token", {})).token,
        );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!settings.data)
    return (
      <>
        <ErrorMessage message={settings.error} />
        {settings.loading && <Loading />}
      </>
    );
  const s = settings.data;
  return (
    <div className="view-stack">
      <ErrorMessage message={error || settings.error} />
      <div className="settings-grid">
        <section className="panel">
          <SectionTitle
            title="Workspace"
            description="Local services and your public address"
          />
          <div className="settings-facts">
            <div>
              <span>Web application</span>
              <code>
                {s.host}:{s.port}
              </code>
            </div>
            <div>
              <span>Public address</span>
              <a href={s.appUrl}>{s.appUrl}</a>
            </div>
            <div>
              <span>Bank callback</span>
              <code>{s.bankingRedirect}</code>
            </div>
            <div>
              <span>Timezone</span>
              <strong>Europe/Tallinn</strong>
            </div>
            <div>
              <span>Last worker heartbeat</span>
              <strong>{dateTime(s.workerAt)}</strong>
            </div>
            <div>
              <span>Banking credentials</span>
              <Badge variant={s.bankingConfigured ? "success" : "warning"}>
                {check
                  ? check.active
                    ? `${check.environment} · Active`
                    : "Inactive application"
                  : s.bankingConfigured
                    ? "Configured"
                    : "Missing"}
              </Badge>
            </div>
          </div>
          <div className="padded-form">
            <button
              className="button secondary"
              onClick={async () => {
                try {
                  setCheck(await api("settings/banking-check", {}));
                  ctx.notify("Enable Banking credentials checked.");
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <ShieldCheck size={16} />
              Verify banking access
            </button>
          </div>
        </section>
        <section className="panel">
          <SectionTitle
            title="Receipt email bridge"
            description="Forward receipts with Cloudflare Email Routing."
          />
          <div className="padded-form">
            <p className="muted">
              Forward emails to a dedicated address such as{" "}
              <strong>receipts@receipts.example.com</strong>. The included Email
              Worker delivers the original email here and buffers it for up to
              seven days while your machine is offline.
            </p>
            <label>
              Inbound API endpoint
              <code className="copy-field">{s.inboundUrl}</code>
            </label>
            <div className="button-row">
              <button className="button secondary" onClick={reveal}>
                {token ? <EyeOff size={16} /> : <Eye size={16} />}
                {token ? "Hide bridge token" : "Reveal bridge token"}
              </button>
              {token && (
                <button
                  className="button secondary"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(token);
                      ctx.notify("Bridge token copied.");
                    } catch {
                      setError(
                        "Clipboard access was unavailable. Select and copy the token.",
                      );
                    }
                  }}
                >
                  <Copy size={15} />
                  Copy
                </button>
              )}
            </div>
            {token && <code className="secret-field">{token}</code>}
            <p className="muted small">
              Use this token as the Worker’s <code>INBOUND_EMAIL_TOKEN</code>{" "}
              secret. The deployable bridge and setup instructions are in{" "}
              <code>integrations/cloudflare</code>. No bank keys are sent to
              Cloudflare.
            </p>
            <a
              className="text-link"
              href="https://developers.cloudflare.com/email-service/platform/pricing/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Cloudflare free plan details
              <ArrowUpRight size={15} />
            </a>
          </div>
        </section>
      </div>
      <section className="panel">
        <SectionTitle
          title="Connect an existing mailbox"
          description="Optional: use a dedicated IMAP folder on an existing or self-hosted mail server."
        />
        <MailboxForm context={ctx} mailbox={s.mailbox} />
      </section>
      <section className="panel">
        <SectionTitle
          title="Received email"
          description="Open forwarding confirmations here to read the code or follow Gmail’s confirmation link."
        />
        <ErrorMessage message={emails.error} />
        <div className="padded-form">
          <p className="muted small">
            Add your receipt address in Gmail’s forwarding settings, then open
            the confirmation email below. Copy its code into Gmail or open the
            confirmation link, then return to Gmail to enable forwarding or
            create a filter for receipts. For IMAP, use Check now to fetch it.
          </p>
        </div>
        {selectedEmail && (
          <div className="email-message source-details" aria-live="polite">
            <div className="button-row">
              <strong>{message.data?.subject || "Loading email…"}</strong>
              <button
                className="text-link"
                onClick={() => setSelectedEmail(null)}
              >
                Close message
              </button>
            </div>
            <ErrorMessage message={message.error} />
            {message.loading && !message.data && <Loading />}
            {message.data && (
              <>
                <p className="muted small">{message.data.sender}</p>
                {message.data.verification && (
                  <div className="notice">
                    <div>
                      <strong>Forwarding verification</strong>
                      <p>
                        Confirm only if you requested this forwarding setup.
                      </p>
                      <div className="button-row">
                        {message.data.verification.code && (
                          <>
                            <code>{message.data.verification.code}</code>
                            <button
                              className="button secondary small-button"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(
                                    message.data!.verification!.code!,
                                  );
                                  ctx.notify("Confirmation code copied.");
                                } catch {
                                  setError(
                                    "Could not copy the code. Select and copy it manually.",
                                  );
                                }
                              }}
                            >
                              <Copy size={14} />
                              Copy code
                            </button>
                          </>
                        )}
                        {message.data.verification.url && (
                          <a
                            className="button secondary small-button"
                            href={message.data.verification.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Open Gmail confirmation
                            <ArrowUpRight size={14} />
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                <pre>
                  {message.data.text ||
                    "This email has no readable message body. Download the original to inspect its attachments."}
                </pre>
              </>
            )}
          </div>
        )}
        {emails.loading && !emails.data ? (
          <Loading />
        ) : !emails.data?.length ? (
          <div className="padded-form">
            <p>No emails received yet.</p>
            <p className="muted">
              Messages appear here as soon as they reach the app, even if no
              receipt is recognized. If you have sent a message, check your
              email routing rule and delivery logs, or use Check now for a
              connected mailbox.
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Subject / sender</th>
                  <th>Received</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {emails.data!.map((email) => (
                  <tr key={email.id}>
                    <td>
                      <strong>{email.subject || "Receipt email"}</strong>
                      <small>{email.sender || "Processing…"}</small>
                      {email.error && (
                        <small className="danger-text">{email.error}</small>
                      )}
                    </td>
                    <td>{dateTime(email.received_at)}</td>
                    <td>
                      <Badge
                        variant={
                          email.status === "complete" ? "success" : "warning"
                        }
                      >
                        {email.status}
                      </Badge>
                    </td>
                    <td>
                      <div className="button-row">
                        <button
                          className="text-link"
                          onClick={() => setSelectedEmail(email.id)}
                        >
                          Open message
                        </button>
                        <a
                          className="text-link"
                          href={`/api/emails/${email.id}/file`}
                        >
                          Original
                        </a>
                        {!["complete", "verification"].includes(
                          email.status,
                        ) && (
                          <button
                            className="text-link"
                            onClick={async () => {
                              try {
                                await api(`emails/${email.id}/retry`, {});
                                ctx.notify("Email queued for retry.");
                                ctx.refresh();
                              } catch (e) {
                                setError((e as Error).message);
                              }
                            }}
                          >
                            Retry
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <div className="settings-grid">
        <section className="panel">
          <SectionTitle title="Categories" />
          <div className="category-edit-list">
            {ctx.state.categories.map((category) => (
              <CategoryEditor
                key={category.id}
                category={category}
                context={ctx}
              />
            ))}
            <CategoryEditor context={ctx} />
          </div>
        </section>
        <section className="panel">
          <SectionTitle
            title="Account password"
            description="Changing it signs out your other sessions."
          />
          <PasswordForm context={ctx} />
          <div className="export-options">
            <h3>Export data</h3>
            <p>
              Download expenses, category allocations, or individual receipt
              products.
            </p>
            <div className="button-row">
              {[
                ["expenses", "Expenses"],
                ["allocations", "Categories"],
                ["items", "Products"],
              ].map(([type, label]) => (
                <a
                  className="button secondary"
                  key={type}
                  href={`/api/export?type=${type}`}
                >
                  {label} CSV
                </a>
              ))}
            </div>
            <p className="small muted">
              Encrypted backups: <code>npm run backup</code>. Restore
              instructions are in the project README.
            </p>
          </div>
        </section>
      </div>
      <section className="panel">
        <SectionTitle
          title="Import activity"
          description="Progress and errors from the background worker"
        />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Source</th>
                <th>Status</th>
                <th>Imported</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {imports.data?.map((run) => (
                <tr key={run.id}>
                  <td>{dateTime(run.started_at)}</td>
                  <td className="capitalize">{run.type}</td>
                  <td>
                    <Badge
                      variant={
                        run.status === "complete"
                          ? "success"
                          : run.status === "error"
                            ? "warning"
                            : "neutral"
                      }
                    >
                      {run.status}
                    </Badge>
                  </td>
                  <td>{run.count}</td>
                  <td className="muted small">{run.error || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {imports.data?.length === 0 && (
          <Empty
            title="No imports yet"
            text="Bank and receipt activity will appear here."
          />
        )}
      </section>
    </div>
  );
}
function MailboxForm({
  context: ctx,
  mailbox,
}: {
  context: AppContext;
  mailbox: Settings["mailbox"];
}) {
  const [host, setHost] = useState(mailbox?.host || ""),
    [port, setPort] = useState(mailbox?.port || 993),
    [user, setUser] = useState(mailbox?.user || ""),
    [password, setPassword] = useState(""),
    [accessToken, setAccessToken] = useState(""),
    [folder, setFolder] = useState(mailbox?.folder || "INBOX"),
    [secure, setSecure] = useState(mailbox?.secure ?? true),
    [enabled, setEnabled] = useState(mailbox?.enabled ?? true),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("settings/mailbox", {
        host,
        port,
        user,
        password,
        accessToken,
        folder,
        secure,
        enabled,
      });
      setPassword("");
      setAccessToken("");
      ctx.refresh();
      ctx.notify("Mailbox configuration saved.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="padded-form" onSubmit={save}>
      <ErrorMessage message={error || mailbox?.error || null} />
      <div className="form-grid three">
        <label>
          IMAP host
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="imap.example.com"
            required
          />
        </label>
        <label>
          Port
          <input
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(Number(e.target.value))}
            required
          />
        </label>
        <label>
          Receipt folder
          <input
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            required
          />
        </label>
        <label>
          Email / username
          <input
            value={user}
            onChange={(e) => setUser(e.target.value)}
            required
            autoComplete="off"
          />
        </label>
        <label>
          App password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={
              mailbox?.hasPassword
                ? "Leave blank to keep saved password"
                : "Mailbox app password"
            }
            autoComplete="new-password"
          />
        </label>
        <label>
          OAuth access token (alternative)
          <input
            type="password"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            placeholder="Optional OAuth bearer token"
            autoComplete="off"
          />
        </label>
      </div>
      <div className="button-row">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={secure}
            onChange={(e) => setSecure(e.target.checked)}
          />
          Use TLS
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Check mailbox hourly
        </label>
      </div>
      <div className="button-row">
        <button className="button primary" disabled={busy}>
          {busy ? "Saving…" : "Save mailbox"}
        </button>
        {mailbox && (
          <button
            type="button"
            className="button secondary"
            onClick={async () => {
              try {
                await api("settings/mailbox/sync", {});
                ctx.notify("Mailbox check queued.");
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <RefreshCw size={15} />
            Check now
          </button>
        )}
        <span className="muted small">
          Last check: {dateTime(mailbox?.lastSyncAt)}
        </span>
      </div>
      <p className="muted small">
        Messages are read without marking them as seen or deleting them. OAuth
        access tokens need renewal when they expire; an app password is simpler
        for unattended polling.
      </p>
    </form>
  );
}
function CategoryEditor({
  category,
  context: ctx,
}: {
  category?: Category;
  context: AppContext;
}) {
  const [name, setName] = useState(category?.name || ""),
    [color, setColor] = useState(category?.color || "#447a5d"),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (category) {
      setName(category.name);
      setColor(category.color);
    }
  }, [category?.name, category?.color]);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api("categories", { id: category?.id, name, color });
          if (!category) setName("");
          ctx.refresh();
          ctx.notify("Category saved.");
          setError(null);
        } catch (e) {
          setError((e as Error).message);
        }
      }}
    >
      <input
        type="color"
        aria-label={`${category?.name || "New category"} color`}
        value={color}
        onChange={(e) => setColor(e.target.value)}
      />
      <input
        aria-label={`${category?.name || "New category"} name`}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Add a category…"
        required
        maxLength={80}
      />
      <button
        className="icon-button"
        aria-label={category ? `Save ${category.name}` : "Add category"}
      >
        {category ? <CheckCheck size={17} /> : <Plus size={17} />}
      </button>
      {error && <small className="danger-text">{error}</small>}
    </form>
  );
}
function PasswordForm({ context: ctx }: { context: AppContext }) {
  const [current, setCurrent] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  return (
    <form
      className="padded-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        if (password !== confirm) {
          setError("The passwords do not match.");
          return;
        }
        setBusy(true);
        try {
          await api("settings/password", {
            currentPassword: current,
            password,
          });
          setCurrent("");
          setPassword("");
          setConfirm("");
          ctx.notify("Password changed.");
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <ErrorMessage message={error} />
      <label>
        Current password
        <input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
      </label>
      <label>
        New password
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={12}
          maxLength={256}
          required
        />
      </label>
      <label>
        Confirm new password
        <input
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          minLength={12}
          required
        />
      </label>
      <button className="button primary" disabled={busy}>
        {busy ? "Updating…" : "Change password"}
      </button>
    </form>
  );
}
