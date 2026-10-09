import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalize } from "../src/lib/classification";
import { parseWoltReceipt, woltChargeCategory } from "../src/lib/wolt-receipt";
import { config } from "../src/server/config";
import { pool, query, transaction } from "../src/server/db";
import { applyAllocations } from "../src/server/ledger";

// Preview by default; --apply saves corrections and refreshes linked accounting.
const apply = process.argv.includes("--apply");
try {
  await transaction(async (db) => {
    const receipts = await query(
      `SELECT r.* FROM receipts r WHERE retailer='wolt' AND EXISTS (
        SELECT 1 FROM receipt_items i WHERE i.receipt_id=r.id
        AND i.description ~* '^(Delivery|Tip for courier|Service fee|Wolt[+] service fee discount)$'
      ) ORDER BY r.id FOR UPDATE`,
      [],
      db,
    );
    const changes: {
      receiptId: string;
      itemId: string;
      description: string;
      before: string;
      after: string;
      manual: boolean;
    }[] = [];
    for (const receipt of receipts) {
      const items = await query(
        "SELECT * FROM receipt_items WHERE receipt_id=$1 ORDER BY position FOR UPDATE",
        [receipt.id],
        db,
      );
      const parsed = parseWoltReceipt(receipt.text);
      if (
        !parsed?.valid ||
        parsed.items.length !== items.length ||
        parsed.items.some(
          (item, index) =>
            item.description !== items[index].description ||
            item.amount !== items[index].amount,
        )
      )
        throw new Error(
          `Receipt ${receipt.id} needs review before categorization.`,
        );
      for (const [index, item] of items.entries()) {
        const category =
          woltChargeCategory(item.description) ||
          (item.amount < 0 &&
          /^discount$/i.test(item.description) &&
          ["shipping", "fees_taxes"].includes(parsed.items[index].categoryId)
            ? parsed.items[index].categoryId
            : null);
        if (category && item.category_id !== category)
          changes.push({
            receiptId: receipt.id,
            itemId: item.id,
            description: item.description,
            before: item.category_id,
            after: category,
            manual: item.manual,
          });
      }
    }
    const receiptIds = [...new Set(changes.map((change) => change.receiptId))];
    console.log(
      JSON.stringify({
        apply,
        receipts: receiptIds.length,
        items: changes.length,
        categories: Object.fromEntries(
          ["shipping", "fees_taxes"].map((category) => [
            category,
            changes.filter((change) => change.after === category).length,
          ]),
        ),
      }),
    );
    if (!apply || !changes.length) return;
    const links = await query(
      "SELECT DISTINCT transaction_id FROM receipt_payments WHERE receipt_id=ANY($1::uuid[]) ORDER BY transaction_id",
      [receiptIds],
      db,
    );
    const allocations = await query(
      "SELECT * FROM allocations WHERE transaction_id=ANY($1::uuid[])",
      [links.map((link) => link.transaction_id)],
      db,
    );
    const mappings = await query(
      "SELECT * FROM product_mappings WHERE retailer='wolt'",
      [],
      db,
    );
    await mkdir(config.dataDir, { recursive: true });
    const backup = path.join(
      config.dataDir,
      `wolt-charge-categories-${Date.now()}.json`,
    );
    await writeFile(
      backup,
      JSON.stringify({ changes, allocations, mappings }, null, 2),
      { mode: 0o600 },
    );
    for (const change of changes) {
      await db.query(
        "UPDATE receipt_items SET category_id=$2,manual=true WHERE id=$1",
        [change.itemId, change.after],
      );
      if (woltChargeCategory(change.description))
        await db.query(
          "INSERT INTO product_mappings(retailer,product,category_id) VALUES('wolt',$1,$2) ON CONFLICT(retailer,product) DO UPDATE SET category_id=excluded.category_id",
          [normalize(change.description), change.after],
        );
    }
    for (const receiptId of receiptIds) {
      await db.query("UPDATE receipts SET updated_at=now() WHERE id=$1", [
        receiptId,
      ]);
      await db.query(
        "INSERT INTO corrections(entity,entity_id,change) VALUES('receipt',$1,$2)",
        [
          receiptId,
          JSON.stringify({
            reason: "Correct Wolt delivery and service charge categories",
            items: changes.filter((change) => change.receiptId === receiptId),
          }),
        ],
      );
    }
    for (const link of links) await applyAllocations(link.transaction_id, db);
    console.log(JSON.stringify({ refreshedPayments: links.length, backup }));
  });
} finally {
  await pool.end();
}
