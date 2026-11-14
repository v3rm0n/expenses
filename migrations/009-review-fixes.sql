-- Parser categories let product-rule changes be undone without losing
-- retailer-specific categories. Older rows keep NULL and their current category.
ALTER TABLE receipt_items ADD COLUMN parsed_category_id text REFERENCES categories(id);
INSERT INTO schema_migrations(version) VALUES(9);
