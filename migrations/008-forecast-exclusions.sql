ALTER TABLE transactions ADD COLUMN forecast_excluded boolean NOT NULL DEFAULT false;
INSERT INTO schema_migrations(version) VALUES(8);
