-- Debits are positive and credits negative; every journal balances in one currency.
CREATE TABLE ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  type text NOT NULL CHECK(type IN ('asset','liability','equity','income','expense')),
  currency text NOT NULL,
  source_account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  category_id text REFERENCES categories(id),
  UNIQUE(id,currency)
);
CREATE TABLE journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  opening_account_id uuid UNIQUE,
  currency text NOT NULL,
  booked_at date NOT NULL,
  description text NOT NULL,
  CHECK((transaction_id IS NOT NULL) <> (opening_account_id IS NOT NULL)),
  FOREIGN KEY(opening_account_id,currency) REFERENCES ledger_accounts(id,currency),
  UNIQUE(id,currency)
);
CREATE TABLE journal_postings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL,
  account_id uuid NOT NULL,
  currency text NOT NULL,
  amount bigint NOT NULL CHECK(amount<>0 AND amount BETWEEN -9007199254740991 AND 9007199254740991),
  debit bigint GENERATED ALWAYS AS (greatest(amount,0)) STORED,
  credit bigint GENERATED ALWAYS AS (greatest(-amount,0)) STORED,
  source text NOT NULL,
  FOREIGN KEY(entry_id,currency) REFERENCES journal_entries(id,currency) ON DELETE CASCADE,
  FOREIGN KEY(account_id,currency) REFERENCES ledger_accounts(id,currency)
);
CREATE INDEX journal_postings_entry ON journal_postings(entry_id);
CREATE INDEX journal_postings_account ON journal_postings(account_id);
CREATE INDEX journal_entries_date ON journal_entries(booked_at);

CREATE FUNCTION ensure_ledger_account(account_code text, account_name text, account_type text,
  account_currency text, bank_id uuid DEFAULT NULL, category text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE result uuid;
BEGIN
  INSERT INTO ledger_accounts(code,name,type,currency,source_account_id,category_id)
    VALUES(account_code,account_name,account_type,account_currency,bank_id,category)
    ON CONFLICT(code) DO NOTHING;
  SELECT id INTO result FROM ledger_accounts WHERE code=account_code;
  RETURN result;
END $$;

CREATE FUNCTION provision_ledger_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.currency IS NOT NULL THEN
    IF NEW.source='cash' THEN
      PERFORM ensure_ledger_account('cash:'||NEW.currency,'Cash','asset',NEW.currency);
    ELSE
      PERFORM ensure_ledger_account('bank:'||NEW.id||':'||NEW.currency,NEW.name,'asset',NEW.currency,NEW.id);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provision_account_ledger AFTER INSERT OR UPDATE OF currency ON accounts
  FOR EACH ROW EXECUTE FUNCTION provision_ledger_account();

CREATE FUNCTION sync_transaction_journal(transaction_uuid uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  t transactions%ROWTYPE;
  bank accounts%ROWTYPE;
  journal_id uuid;
  cash_account uuid;
  counterpart uuid;
  allocation record;
  allocated numeric := 0;
BEGIN
  SELECT * INTO t FROM transactions WHERE id=transaction_uuid FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF t.status<>'BOOK' THEN
    DELETE FROM journal_entries WHERE transaction_id=t.id;
    RETURN;
  END IF;
  SELECT * INTO bank FROM accounts WHERE id=t.account_id;
  IF bank.source='cash' THEN
    cash_account := ensure_ledger_account('cash:'||t.currency,'Cash','asset',t.currency);
  ELSE
    cash_account := ensure_ledger_account('bank:'||bank.id||':'||t.currency,bank.name,'asset',t.currency,bank.id);
  END IF;
  -- Keep the entry identity across corrections, but replace its financial postings atomically.
  SELECT id INTO journal_id FROM journal_entries WHERE transaction_id=t.id;
  DELETE FROM journal_postings WHERE entry_id=journal_id;
  INSERT INTO journal_entries(transaction_id,currency,booked_at,description)
    VALUES(t.id,t.currency,t.booked_at,t.merchant)
    ON CONFLICT(transaction_id) DO UPDATE SET currency=excluded.currency,
      booked_at=excluded.booked_at,description=excluded.description RETURNING id INTO journal_id;
  INSERT INTO journal_postings(entry_id,account_id,currency,amount,source)
    VALUES(journal_id,cash_account,t.currency,t.amount,'transaction');
  IF t.kind IN ('expense','refund') THEN
    FOR allocation IN SELECT a.*,c.name FROM allocations a JOIN categories c ON c.id=a.category_id
      WHERE a.transaction_id=t.id AND a.amount<>0 ORDER BY a.category_id LOOP
      counterpart := ensure_ledger_account('expense:'||allocation.category_id||':'||t.currency,
        allocation.name,'expense',t.currency,NULL,allocation.category_id);
      INSERT INTO journal_postings(entry_id,account_id,currency,amount,source)
        VALUES(journal_id,counterpart,t.currency,allocation.amount,allocation.source);
      allocated := allocated+allocation.amount;
    END LOOP;
    -- Transactions without complete categorization still have a complete journal.
    IF -t.amount-allocated<>0 THEN
      counterpart := ensure_ledger_account('expense:uncategorized:'||t.currency,
        'Uncategorized','expense',t.currency,NULL,'uncategorized');
      INSERT INTO journal_postings(entry_id,account_id,currency,amount,source)
        VALUES(journal_id,counterpart,t.currency,-t.amount-allocated,'uncategorized');
    END IF;
  ELSE
    IF t.kind='income' THEN
      counterpart := ensure_ledger_account('income:'||t.currency,'Income','income',t.currency);
    ELSIF t.kind='cash_movement' AND bank.source<>'cash' THEN
      counterpart := ensure_ledger_account('cash:'||t.currency,'Cash','asset',t.currency);
    ELSIF t.kind IN ('investment','pension') AND NOT EXISTS(
      SELECT 1 FROM accounts a WHERE a.source<>'cash' AND a.id<>t.account_id
        AND a.iban IS NOT NULL AND t.counterparty_iban IS NOT NULL
        AND upper(regexp_replace(a.iban,'\s','','g'))=upper(regexp_replace(t.counterparty_iban,'\s','','g'))
    ) THEN
      counterpart := ensure_ledger_account(t.kind||':'||t.currency,
        CASE WHEN t.kind='investment' THEN 'Investments' ELSE 'Pension' END,'asset',t.currency);
    ELSE
      -- Both imported sides of a transfer offset in clearing, without doubling bank balances.
      -- Unmatched transfers and currency exchanges remain visible separately per currency.
      counterpart := ensure_ledger_account('transfers:'||t.currency,'Transfer clearing','asset',t.currency);
    END IF;
    INSERT INTO journal_postings(entry_id,account_id,currency,amount,source)
      VALUES(journal_id,counterpart,t.currency,-t.amount,'transaction');
  END IF;
END $$;

CREATE FUNCTION transaction_journal_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM sync_transaction_journal(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER transaction_journal_sync AFTER INSERT OR UPDATE OF amount,currency,kind,status,
  booked_at,account_id,merchant,counterparty_iban ON transactions FOR EACH ROW EXECUTE FUNCTION transaction_journal_changed();
CREATE FUNCTION account_journals_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record; previous_iban text;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.iban IS NOT DISTINCT FROM NEW.iban AND OLD.source IS NOT DISTINCT FROM NEW.source THEN
      RETURN NEW;
    END IF;
    previous_iban := OLD.iban;
  END IF;
  FOR item IN SELECT id FROM transactions WHERE account_id=NEW.id OR
    (counterparty_iban IS NOT NULL AND upper(regexp_replace(counterparty_iban,'\s','','g')) IN
      (upper(regexp_replace(NEW.iban,'\s','','g')),upper(regexp_replace(previous_iban,'\s','','g')))) ORDER BY id LOOP
    PERFORM sync_transaction_journal(item.id);
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER account_journal_sync AFTER INSERT OR UPDATE OF iban,source ON accounts
  FOR EACH ROW EXECUTE FUNCTION account_journals_changed();
CREATE FUNCTION allocation_journal_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN PERFORM sync_transaction_journal(OLD.transaction_id); END IF;
  IF TG_OP<>'DELETE' THEN
    IF TG_OP='INSERT' OR NEW.transaction_id<>OLD.transaction_id THEN
      PERFORM sync_transaction_journal(NEW.transaction_id);
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER allocation_journal_sync AFTER INSERT OR UPDATE OR DELETE ON allocations
  FOR EACH ROW EXECUTE FUNCTION allocation_journal_changed();

CREATE FUNCTION assert_journal_balanced(journal_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE posting_count integer; total numeric;
BEGIN
  -- Lock the parent before checking, so concurrent changes cannot bypass balancing.
  PERFORM 1 FROM journal_entries WHERE id=journal_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*),coalesce(sum(amount),0) INTO posting_count,total
    FROM journal_postings WHERE entry_id=journal_id;
  IF posting_count<2 OR total<>0 THEN
    RAISE EXCEPTION 'Journal entry must have at least two postings and equal debits and credits'
      USING ERRCODE='23514';
  END IF;
END $$;
CREATE FUNCTION assert_transaction_journal(transaction_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t transactions%ROWTYPE; journal_count integer; source_amount numeric;
BEGIN
  SELECT * INTO t FROM transactions WHERE id=transaction_uuid FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*) INTO journal_count FROM journal_entries WHERE transaction_id=t.id;
  IF t.status='BOOK' THEN
    IF journal_count<>1 THEN
      RAISE EXCEPTION 'Booked transaction must have exactly one journal entry' USING ERRCODE='23514';
    END IF;
    SELECT sum(p.amount) INTO source_amount FROM journal_entries j
      JOIN journal_postings p ON p.entry_id=j.id JOIN ledger_accounts a ON a.id=p.account_id
      WHERE j.transaction_id=t.id AND p.source='transaction'
        AND (a.source_account_id=t.account_id OR a.code='cash:'||t.currency) AND p.amount=t.amount;
    IF source_amount IS DISTINCT FROM t.amount::numeric OR EXISTS(
      SELECT 1 FROM journal_entries j WHERE j.transaction_id=t.id
        AND (j.currency<>t.currency OR j.booked_at<>t.booked_at)
    ) THEN
      RAISE EXCEPTION 'Journal must match its booked transaction' USING ERRCODE='23514';
    END IF;
  ELSIF journal_count<>0 THEN
    RAISE EXCEPTION 'Only booked transactions may have journal entries' USING ERRCODE='23514';
  END IF;
END $$;
CREATE FUNCTION check_transaction_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_transaction_journal(NEW.id);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER transaction_has_journal AFTER INSERT OR UPDATE ON transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transaction_journal();
CREATE FUNCTION check_journal_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transaction_uuid uuid;
BEGIN
  IF TG_TABLE_NAME='journal_entries' THEN
    IF TG_OP<>'INSERT' THEN PERFORM assert_transaction_journal(OLD.transaction_id); END IF;
    IF TG_OP<>'DELETE' THEN
      PERFORM assert_journal_balanced(NEW.id);
      PERFORM assert_transaction_journal(NEW.transaction_id);
    END IF;
  ELSE
    IF TG_OP<>'INSERT' THEN PERFORM assert_journal_balanced(OLD.entry_id); END IF;
    IF TG_OP<>'DELETE' THEN PERFORM assert_journal_balanced(NEW.entry_id); END IF;
    FOR transaction_uuid IN SELECT j.transaction_id FROM journal_entries j
      WHERE j.id IN (CASE WHEN TG_OP<>'INSERT' THEN OLD.entry_id END,
        CASE WHEN TG_OP<>'DELETE' THEN NEW.entry_id END) LOOP
      PERFORM assert_transaction_journal(transaction_uuid);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_entry_balanced AFTER INSERT OR UPDATE OR DELETE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_journal_balance();
CREATE CONSTRAINT TRIGGER journal_postings_balanced AFTER INSERT OR UPDATE OR DELETE ON journal_postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_journal_balance();

-- Financial reports read these projections of the balanced journal.
CREATE VIEW ledger_transactions AS
  SELECT t.*,p.amount AS ledger_amount FROM transactions t
  JOIN journal_entries j ON j.transaction_id=t.id
  JOIN journal_postings p ON p.entry_id=j.id AND p.source='transaction'
  JOIN ledger_accounts a ON a.id=p.account_id
  WHERE (a.source_account_id=t.account_id OR a.code='cash:'||t.currency)
    AND p.amount=t.amount;
CREATE VIEW ledger_allocations AS
  SELECT j.transaction_id,a.category_id,sum(p.amount)::bigint AS amount,
    CASE WHEN count(DISTINCT p.source)=1 THEN min(p.source) ELSE 'mixed' END AS source
  FROM journal_postings p JOIN journal_entries j ON j.id=p.entry_id
  JOIN ledger_accounts a ON a.id=p.account_id
  WHERE a.type='expense' AND j.transaction_id IS NOT NULL
  GROUP BY j.transaction_id,a.category_id;

DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT * FROM accounts WHERE currency IS NOT NULL ORDER BY id LOOP
    IF item.source='cash' THEN
      PERFORM ensure_ledger_account('cash:'||item.currency,'Cash','asset',item.currency);
    ELSE
      PERFORM ensure_ledger_account('bank:'||item.id||':'||item.currency,item.name,'asset',item.currency,item.id);
    END IF;
  END LOOP;
  FOR item IN SELECT id FROM transactions WHERE status='BOOK' ORDER BY id LOOP
    PERFORM sync_transaction_journal(item.id);
  END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES(3);
