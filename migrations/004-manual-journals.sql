-- Imported, opening, and manual journals share the same balancing constraints.
-- A fresh installation may have queued balance checks from the history backfill.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_check;
ALTER TABLE journal_entries ADD COLUMN manual_key uuid UNIQUE;
ALTER TABLE journal_entries ADD COLUMN reference text NOT NULL DEFAULT '';
ALTER TABLE journal_entries ADD COLUMN notes text NOT NULL DEFAULT '';
ALTER TABLE journal_entries ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE journal_entries ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE journal_entries ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE journal_entries ADD COLUMN creation_hash text;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entry_origin CHECK(
  num_nonnulls(transaction_id,opening_account_id,manual_key)=1
);
ALTER TABLE journal_postings ADD COLUMN memo text NOT NULL DEFAULT '';
ALTER TABLE journal_postings ADD COLUMN position integer NOT NULL DEFAULT 0;
ALTER TABLE ledger_accounts ADD COLUMN display_code text;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_account_display_code UNIQUE(currency,display_code);
CREATE INDEX journal_entries_order ON journal_entries(currency,booked_at,created_at,id);
INSERT INTO schema_migrations(version) VALUES(4);
SET CONSTRAINTS ALL DEFERRED;
