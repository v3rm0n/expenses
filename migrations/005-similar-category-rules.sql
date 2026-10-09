CREATE TABLE similar_category_rules (
  merchant text NOT NULL CHECK(length(merchant)>0),
  pattern text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('expense','refund')),
  currency text NOT NULL,
  category_id text NOT NULL REFERENCES categories(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(merchant,pattern,kind,currency)
);
INSERT INTO schema_migrations(version) VALUES(5);
