ALTER TABLE accounts ADD COLUMN ignored boolean NOT NULL DEFAULT false;
INSERT INTO schema_migrations(version) VALUES(6);
