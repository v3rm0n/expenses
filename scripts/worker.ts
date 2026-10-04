import { decrypt } from "../src/server/crypto";
import { assertConfig } from "../src/server/config";
import { migrate, pool, query } from "../src/server/db";
import { getQueue, enqueue } from "../src/server/queue";
import { syncBank } from "../src/server/banking";
import { processReceipt } from "../src/server/receipts";
import { syncLidl } from "../src/server/lidl";
import { processEmail, syncImap } from "../src/server/email";
assertConfig();
await migrate();
const boss = await getQueue();
await boss.work<{ connectionId: string; psuHeaders?: Record<string, string> }>(
  "bank-sync",
  { localConcurrency: 1 },
  async (jobs) => {
    for (const job of jobs)
      await syncBank(job.data.connectionId, job.data.psuHeaders);
  },
);
await boss.work<{ receiptId: string }>(
  "receipt-parse",
  { localConcurrency: 1 },
  async (jobs) => {
    for (const job of jobs) await processReceipt(job.data.receiptId);
  },
);
await boss.work<{ emailId: string }>(
  "email-parse",
  { localConcurrency: 1 },
  async (jobs) => {
    for (const job of jobs) await processEmail(job.data.emailId);
  },
);
await boss.work("imap-sync", { localConcurrency: 1 }, async () => syncImap());
await boss.work("lidl-sync", { localConcurrency: 1 }, async () => syncLidl());
async function maintenance() {
  await query(
    "INSERT INTO settings(key,value) VALUES('worker_heartbeat','true') ON CONFLICT(key) DO UPDATE SET updated_at=now()",
  );
  await query("DELETE FROM web_sessions WHERE expires_at<now()");
  await query("DELETE FROM auth_attempts WHERE expires_at<now()");
  await query(
    "DELETE FROM bank_states WHERE expires_at<now()-interval '1 day'",
  );
  await query(
    "UPDATE bank_connections SET status='expired' WHERE valid_until<now() AND status='active'",
  );
  for (const connection of await query(
    "SELECT id FROM bank_connections WHERE status='active' AND valid_until>now() AND (last_attempt_at IS NULL OR last_attempt_at<now()-interval '24 hours')",
  ))
    await enqueue("bank-sync", { connectionId: connection.id }, connection.id);
  for (const receipt of await query(
    "SELECT id FROM receipts WHERE status='processing' AND NOT manual",
  ))
    await enqueue("receipt-parse", { receiptId: receipt.id }, receipt.id);
  for (const email of await query(
    "SELECT id FROM inbound_emails WHERE status='received'",
  ))
    await enqueue("email-parse", { emailId: email.id }, email.id);
  const [lidl] = await query("SELECT value FROM settings WHERE key='lidl'");
  if (
    lidl?.value?.cipher &&
    decrypt<{ enabled: boolean }>(lidl.value.cipher).enabled &&
    (!lidl.value.lastAttemptAt ||
      new Date(lidl.value.lastAttemptAt).valueOf() < Date.now() - 86400000)
  )
    await enqueue("lidl-sync", {}, "lidl");
  const [mailbox] = await query("SELECT value FROM settings WHERE key='imap'");
  if (
    mailbox &&
    decrypt<{ enabled: boolean }>(mailbox.value.cipher).enabled &&
    (!mailbox.value.lastAttemptAt ||
      new Date(mailbox.value.lastAttemptAt).valueOf() < Date.now() - 3600000)
  )
    await enqueue("imap-sync", {}, "imap");
}
await boss.work("maintenance", async () => maintenance());
await boss.schedule(
  "maintenance",
  "* * * * *",
  {},
  { singletonKey: "maintenance" },
);
await maintenance();
console.log(
  "Import worker ready. Bank and Lidl imports run daily; mailbox checks run hourly.",
);
let stopped = false;
async function stop() {
  if (stopped) return;
  stopped = true;
  await boss.stop({ graceful: true, timeout: 20000 });
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
