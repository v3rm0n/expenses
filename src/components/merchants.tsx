"use client";
import { useState, type FormEvent } from "react";
import {
  api,
  useData,
  ErrorMessage,
  Loading,
  SectionTitle,
  type AppContext,
} from "./ui";

type Group = { id: string; name: string; aliases: string[] };
type MerchantData = {
  groups: Group[];
  names: Array<{ name: string; merchant_group: string }>;
};
export function MerchantGroups({ context: ctx }: { context: AppContext }) {
  const data = useData<MerchantData>("merchants", ctx.revision);
  const [editing, setEditing] = useState<Group | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = aliases
    .split("\n")
    .map((alias) => alias.trim())
    .filter(Boolean);
  const start = (group: Group | null) => {
    setEditing(group);
    setName(group?.name || "");
    setAliases(group?.aliases.join("\n") || "");
    setSearch("");
    setError(null);
    setOpen(true);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("merchants", { id: editing?.id, name, aliases: selected });
      setOpen(false);
      ctx.refresh();
      ctx.notify("Merchant group saved. Reports now include all its aliases.");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (group: Group) => {
    setBusy(true);
    setError(null);
    try {
      await api(`merchants/${group.id}`, undefined, "DELETE");
      if (editing?.id === group.id) setOpen(false);
      ctx.refresh();
      ctx.notify("Merchant group removed. Original names are used again.");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <SectionTitle
        title="Merchants"
        description="Group names for the same company. Applies to past and future transactions; original names stay in transaction details."
      />
      <div className="padded-form">
        <ErrorMessage message={error || data.error} />
        {data.loading && !data.data && <Loading />}
        {data.data?.groups.map((group) => (
          <div className="merchant-group-row" key={group.id}>
            <div>
              <strong>{group.name}</strong>
              <p className="muted">{group.aliases.join(" · ")}</p>
            </div>
            <div className="button-row">
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => start(group)}
              >
                Edit {group.name}
              </button>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => remove(group)}
              >
                Ungroup {group.name}
              </button>
            </div>
          </div>
        ))}
        {!open && (
          <button
            className="button secondary"
            disabled={busy || !data.data}
            onClick={() => start(null)}
          >
            Group merchants
          </button>
        )}
        {open && (
          <form className="merchant-group-form" onSubmit={save}>
            <label>
              Display name
              <input
                required
                maxLength={200}
                value={name}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Selver"
              />
            </label>
            <label>
              Find imported names
              <input
                value={search}
                disabled={busy}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search merchant names…"
              />
            </label>
            <div
              className="merchant-alias-options"
              role="group"
              aria-label="Imported merchant names"
            >
              {data.data?.names
                .filter((row) =>
                  row.name
                    .toLocaleLowerCase()
                    .includes(search.toLocaleLowerCase()),
                )
                .map((row) => {
                  const owner = data.data?.groups.find(
                    (group) =>
                      group.id !== editing?.id &&
                      group.aliases.some(
                        (alias) =>
                          alias
                            .normalize("NFKC")
                            .toLocaleLowerCase()
                            .replace(/\s+/g, " ")
                            .trim() ===
                          row.name
                            .normalize("NFKC")
                            .toLocaleLowerCase()
                            .replace(/\s+/g, " ")
                            .trim(),
                      ),
                  );
                  return (
                    <label key={row.name}>
                      <input
                        type="checkbox"
                        disabled={busy || Boolean(owner)}
                        checked={selected.includes(row.name)}
                        onChange={(event) =>
                          setAliases(
                            event.target.checked
                              ? [...selected, row.name].join("\n")
                              : selected
                                  .filter((alias) => alias !== row.name)
                                  .join("\n"),
                          )
                        }
                      />
                      <span>
                        {row.name}
                        {owner && (
                          <small className="muted">
                            {" "}
                            · grouped as {owner.name}
                          </small>
                        )}
                      </span>
                    </label>
                  );
                })}
            </div>
            <label>
              Aliases, one per line
              <textarea
                rows={5}
                value={aliases}
                disabled={busy}
                onChange={(event) => setAliases(event.target.value)}
                placeholder="Select imported names above or enter aliases here."
              />
            </label>
            <p className="muted">
              Capitalization and extra spaces are ignored. The display name is
              also an alias. Removing an alias restores its original name in
              reports.
            </p>
            <div className="button-row">
              <button className="button primary" disabled={busy}>
                Save group
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
