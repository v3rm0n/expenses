CREATE OR REPLACE VIEW ledger_transactions AS
  SELECT t.*,p.amount AS ledger_amount FROM transactions t
  JOIN journal_entries j ON j.transaction_id=t.id
  JOIN journal_postings p ON p.entry_id=j.id AND p.source='transaction'
  JOIN ledger_accounts a ON a.id=p.account_id
  WHERE (a.source_account_id=t.account_id OR a.code='cash:'||t.currency)
    AND p.amount=t.amount
    AND EXISTS(SELECT 1 FROM accounts b WHERE b.id=t.account_id AND NOT b.ignored);

INSERT INTO schema_migrations(version) VALUES(7);
