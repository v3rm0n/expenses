import { query, transaction } from "./db";
import { AppError } from "./errors";

export async function merchantGroups() {
  const [groups, names] = await Promise.all([
    query(`SELECT m.id,m.name,array_agg(a.alias ORDER BY a.alias) AS aliases
      FROM merchants m JOIN merchant_aliases a ON a.merchant_id=m.id
      GROUP BY m.id ORDER BY m.name`),
    query(`SELECT name,merchant_name(name) AS merchant_group FROM (
      SELECT merchant AS name FROM transactions UNION SELECT merchant FROM receipts
      WHERE merchant IS NOT NULL) names WHERE length(trim(name))>0 ORDER BY name`),
  ]);
  return { groups, names };
}

export async function saveMerchantGroup(input: {
  id?: string;
  name: string;
  aliases: string[];
}) {
  return transaction(async (db) => {
    // Serialize edits so an alias can only ever belong to one group.
    await db.query("SELECT pg_advisory_xact_lock(4317002)");
    if (
      input.id &&
      !(await query("SELECT id FROM merchants WHERE id=$1", [input.id], db))
        .length
    )
      throw new AppError("Merchant group not found.", 404);
    const aliases = await query<{ alias: string; key: string }>(
      `SELECT DISTINCT ON (merchant_key(alias)) alias,merchant_key(alias) AS key
       FROM unnest($1::text[]) AS alias ORDER BY merchant_key(alias),alias`,
      [[input.name, ...input.aliases]],
      db,
    );
    const conflicts = await query(
      `SELECT a.alias,m.name FROM merchant_aliases a JOIN merchants m ON m.id=a.merchant_id
       WHERE a.alias_key=ANY($1::text[]) AND ($2::uuid IS NULL OR a.merchant_id<>$2)`,
      [aliases.map((a) => a.key), input.id || null],
      db,
    );
    if (conflicts.length)
      throw new AppError(
        `“${conflicts[0].alias}” already belongs to ${conflicts[0].name}. Remove it from that group first.`,
        409,
      );
    const [group] = input.id
      ? await query(
          "UPDATE merchants SET name=$2 WHERE id=$1 RETURNING id",
          [input.id, input.name],
          db,
        )
      : await query(
          "INSERT INTO merchants(name) VALUES($1) RETURNING id",
          [input.name],
          db,
        );
    await db.query("DELETE FROM merchant_aliases WHERE merchant_id=$1", [
      group.id,
    ]);
    for (const alias of aliases)
      await db.query(
        "INSERT INTO merchant_aliases(alias_key,alias,merchant_id) VALUES($1,$2,$3)",
        [alias.key, alias.alias, group.id],
      );
    return group;
  });
}

export async function deleteMerchantGroup(id: string) {
  await transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(4317002)");
    const rows = await query(
      "DELETE FROM merchants WHERE id=$1 RETURNING id",
      [id],
      db,
    );
    if (!rows.length) throw new AppError("Merchant group not found.", 404);
  });
}
