-- Parser categories let product-rule changes be undone without losing
-- retailer-specific categories. Older rows keep NULL and their current category.
ALTER TABLE receipt_items ADD COLUMN parsed_category_id text REFERENCES categories(id);
-- Retailer receipts that were skipped (before the import start date, or
-- deleted by the retailer) are remembered without a stored receipt.
ALTER TABLE retailer_receipts ALTER COLUMN receipt_id DROP NOT NULL;
-- The amount a retailer's purchase history reports; a parsed total that
-- differs sends the receipt to Review.
ALTER TABLE receipts ADD COLUMN expected_total bigint;
-- The booked payment that settled a pending one. A settled pending payment
-- the bank still lists must not return to pending.
ALTER TABLE transactions ADD COLUMN settled_by uuid REFERENCES transactions(id) ON DELETE SET NULL;
-- Cancelled, rejected, and scheduled entries are no longer imported.
UPDATE transactions SET status='SUPERSEDED' WHERE status IN ('CNCL','RJCT','SCHD');
UPDATE transactions SET status='PDNG' WHERE status='HOLD';
INSERT INTO schema_migrations(version) VALUES(9);
