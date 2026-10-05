CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS owner (
  id integer PRIMARY KEY CHECK(id=1), name text NOT NULL, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash text PRIMARY KEY, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth_attempts (key text PRIMARY KEY, attempts integer NOT NULL DEFAULT 1, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS categories (id text PRIMARY KEY, name text NOT NULL, color text NOT NULL);
CREATE TABLE IF NOT EXISTS rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), field text NOT NULL CHECK(field IN ('merchant','description','product')),
  pattern text NOT NULL, category_id text NOT NULL REFERENCES categories(id), priority integer NOT NULL DEFAULT 100,
  enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS product_mappings (
  retailer text NOT NULL, product text NOT NULL, category_id text NOT NULL REFERENCES categories(id),
  PRIMARY KEY(retailer,product)
);
CREATE TABLE IF NOT EXISTS bank_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bank_name text NOT NULL, country text NOT NULL,
  bank_metadata jsonb NOT NULL DEFAULT '{}', session_cipher text NOT NULL, valid_until timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active', last_sync_at timestamptz, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(bank_name,country)
);
CREATE TABLE IF NOT EXISTS bank_states (
  state_hash text PRIMARY KEY, session_hash text NOT NULL, bank jsonb NOT NULL, valid_until timestamptz NOT NULL,
  expires_at timestamptz NOT NULL, used_at timestamptz
);
CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), connection_id uuid REFERENCES bank_connections(id),
  identification_hash text NOT NULL UNIQUE, provider_uid text, iban text, name text NOT NULL,
  currency text, source text NOT NULL DEFAULT 'bank', balance jsonb, history_from date, history_to date,
  last_sync_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type text NOT NULL, status text NOT NULL DEFAULT 'running',
  source_id text, count integer NOT NULL DEFAULT 0, error text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id),
  source_key text NOT NULL, source_reference text, fingerprint text,
  amount bigint NOT NULL CHECK(amount<>0), currency text NOT NULL,
  kind text NOT NULL CONSTRAINT transactions_kind_check CHECK(kind IN ('expense','income','refund','transfer','cash_movement','investment','pension')),
  status text NOT NULL DEFAULT 'BOOK', booked_at date NOT NULL, value_at date,
  merchant text NOT NULL, description text NOT NULL DEFAULT '', counterparty_iban text, mcc text,
  manual boolean NOT NULL DEFAULT false, note text NOT NULL DEFAULT '',
  raw jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,source_key)
);
CREATE INDEX IF NOT EXISTS transactions_dates ON transactions(booked_at DESC);
CREATE INDEX IF NOT EXISTS transactions_merchant ON transactions(merchant);
CREATE TABLE IF NOT EXISTS transaction_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  payload_hash text NOT NULL, raw jsonb NOT NULL, imported_at timestamptz NOT NULL DEFAULT now(), UNIQUE(transaction_id,payload_hash)
);
CREATE TABLE IF NOT EXISTS allocations (
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category_id text NOT NULL REFERENCES categories(id), amount bigint NOT NULL, source text NOT NULL,
  PRIMARY KEY(transaction_id,category_id)
);
CREATE TABLE IF NOT EXISTS receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), file_hash text NOT NULL UNIQUE, filename text NOT NULL,
  content_type text NOT NULL, storage_path text NOT NULL, source text NOT NULL DEFAULT 'upload',
  retailer text NOT NULL DEFAULT 'unknown', merchant text, receipt_number text, purchased_at date,
  currency text NOT NULL DEFAULT 'EUR', total bigint, card_amount bigint, cash_amount bigint,
  text text NOT NULL DEFAULT '', receipt_identity text UNIQUE, parser_version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'processing', issues jsonb NOT NULL DEFAULT '[]', error text,
  manual boolean NOT NULL DEFAULT false, duplicate_of uuid REFERENCES receipts(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS receipt_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), receipt_id uuid NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  position integer NOT NULL, description text NOT NULL, quantity text, unit text, amount bigint NOT NULL,
  category_id text NOT NULL REFERENCES categories(id), manual boolean NOT NULL DEFAULT false,
  UNIQUE(receipt_id,position)
);
CREATE TABLE IF NOT EXISTS receipt_payments (
  receipt_id uuid NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  amount bigint NOT NULL CHECK(amount>0), automatic boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(receipt_id,transaction_id)
);
CREATE TABLE IF NOT EXISTS inbound_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_key text NOT NULL UNIQUE,
  storage_path text NOT NULL, message_id text, sender text, subject text,
  status text NOT NULL DEFAULT 'received', receipt_ids jsonb NOT NULL DEFAULT '[]', error text,
  received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz
);
CREATE TABLE IF NOT EXISTS corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity text NOT NULL, entity_id text NOT NULL,
  change jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE bank_connections ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS order_id text;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS order_total bigint;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS order_currency text;
CREATE INDEX IF NOT EXISTS receipts_order_id ON receipts(order_id) WHERE order_id IS NOT NULL;
ALTER TABLE transactions ALTER COLUMN booked_at DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='booked_transaction_has_date' AND conrelid='transactions'::regclass) THEN
    ALTER TABLE transactions ADD CONSTRAINT booked_transaction_has_date CHECK(status<>'BOOK' OR booked_at IS NOT NULL);
  END IF;
END $$;
INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_kind_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_kind_check CHECK(kind IN ('expense','income','refund','transfer','cash_movement','investment','pension'));

-- External retailer identities prevent downloading the same receipt each day.
CREATE TABLE IF NOT EXISTS retailer_receipts (
  retailer text NOT NULL,
  account_key text NOT NULL,
  external_id text NOT NULL,
  receipt_id uuid NOT NULL REFERENCES receipts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (retailer, account_key, external_id)
);

-- Owner-selected exemptions affect receipt coverage, independently of categories.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS receipt_not_required boolean NOT NULL DEFAULT false;

-- Retire the removed mailbox connection, including its encrypted credentials.
DELETE FROM settings WHERE key='imap';

-- Only complete Amazon order packs may match a combined payment automatically.
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS order_document_count integer;

-- Keep owner nicknames separate from names refreshed by bank imports.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS nickname text;
