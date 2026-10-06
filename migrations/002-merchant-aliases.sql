CREATE OR REPLACE FUNCTION merchant_key(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT lower(trim(regexp_replace(normalize(value, NFKC), '[[:space:]]+', ' ', 'g')))
$$;
CREATE TABLE IF NOT EXISTS merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS merchant_aliases (
  alias_key text PRIMARY KEY CHECK(length(alias_key)>0),
  alias text NOT NULL,
  merchant_id uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS merchant_aliases_merchant ON merchant_aliases(merchant_id);
CREATE OR REPLACE FUNCTION merchant_name(original text) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce((SELECT m.name FROM merchant_aliases a JOIN merchants m ON m.id=a.merchant_id
    WHERE a.alias_key=merchant_key(original)), original)
$$;
WITH company AS (INSERT INTO merchants(name) VALUES('Wolt') RETURNING id)
INSERT INTO merchant_aliases(alias_key,alias,merchant_id)
SELECT merchant_key(alias),alias,id FROM company CROSS JOIN unnest(ARRAY['Wolt','Wolt Eesti Oue']) AS alias;
WITH company AS (INSERT INTO merchants(name) VALUES('Selver') RETURNING id)
INSERT INTO merchant_aliases(alias_key,alias,merchant_id)
SELECT merchant_key(alias),alias,id FROM company CROSS JOIN unnest(ARRAY['Selver','Kotka Selver','Balti Jaama Selver','Tabasalu Selver']) AS alias;
INSERT INTO schema_migrations(version) VALUES(2);
