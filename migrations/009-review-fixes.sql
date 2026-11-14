-- Parser categories let product-rule changes be undone without losing
-- retailer-specific categories. Older rows keep NULL and their current category.
ALTER TABLE receipt_items ADD COLUMN parsed_category_id text REFERENCES categories(id);
-- Retailer receipts that were skipped (before the import start date, or
-- deleted by the retailer) are remembered without a stored receipt.
ALTER TABLE retailer_receipts ALTER COLUMN receipt_id DROP NOT NULL;
-- The amount a retailer's purchase history reports; a parsed total that
-- differs sends the receipt to Review.
ALTER TABLE receipts ADD COLUMN expected_total bigint;
INSERT INTO schema_migrations(version) VALUES(9);
