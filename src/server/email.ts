import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { simpleParser } from "mailparser";
import { convert } from "html-to-text";
import { ImapFlow } from "imapflow";
import { config } from "./config";
import { digest, decrypt } from "./crypto";
import { query } from "./db";
import { AppError } from "./errors";
import { enqueue } from "./queue";
import { MAX_FILE_SIZE, storeReceipt, storageFile } from "./receipts";
import { woltEmailOrder } from "../lib/wolt-receipt";

export const MAX_EMAIL_SIZE = 20 * 1024 * 1024;
export async function receiveEmail(buffer: Buffer) {
  if (!buffer.length || buffer.length > MAX_EMAIL_SIZE)
    throw new AppError("Emails must be between 1 byte and 20 MB.", 413);
  const hash = digest(buffer),
    relative = `emails/${hash}.eml`;
  await mkdir(path.dirname(storageFile(relative)), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(storageFile(relative), buffer, { mode: 0o600 });
  const [email] = await query(
    "INSERT INTO inbound_emails(source_key,storage_path) VALUES($1,$2) ON CONFLICT(source_key) DO UPDATE SET source_key=excluded.source_key RETURNING id,status",
    [hash, relative],
  );
  if (!["complete", "review"].includes(email.status))
    await enqueue("email-parse", { emailId: email.id }, email.id);
  return { id: email.id, status: email.status };
}
export async function processEmail(id: string) {
  const [row] = await query("SELECT * FROM inbound_emails WHERE id=$1", [id]);
  if (!row || row.status === "complete" || row.status === "review") return;
  const ids: string[] = [];
  try {
    const raw = await readFile(storageFile(row.storage_path));
    const email = await simpleParser(raw, {
      skipHtmlToText: true,
      skipTextToHtml: true,
    });
    const bodyParts: string[] = [];
    const collect = async (
      parsed: Awaited<ReturnType<typeof simpleParser>>,
      depth = 0,
    ) => {
      const text =
        parsed.text ||
        (parsed.html
          ? convert(parsed.html, {
              wordwrap: false,
              selectors: [{ selector: "img", format: "skip" }],
            })
          : "");
      const order = woltEmailOrder(text);
      const rimiPdfEmail =
        /\brimi\b/i.test(text) &&
        parsed.attachments.some(
          (attachment) =>
            attachment.contentType === "application/pdf" ||
            /\.pdf$/i.test(attachment.filename || ""),
        );
      for (const attachment of parsed.attachments) {
        if (attachment.content.length > MAX_FILE_SIZE) continue;
        if (attachment.contentType === "message/rfc822" && depth < 3) {
          await collect(
            await simpleParser(attachment.content, { skipHtmlToText: true }),
            depth + 1,
          );
          continue;
        }
        if (
          attachment.contentType.startsWith("image/") &&
          (attachment.contentDisposition === "inline" ||
            // Gmail can turn Rimi's embedded logo into an ordinary attachment
            // named "inline" when forwarding; the receipt is the accompanying PDF.
            (rimiPdfEmail && attachment.filename === "inline"))
        )
          continue;
        if (
          /\.(pdf|png|jpe?g|txt|csv)$/i.test(attachment.filename || "") ||
          /^(application\/pdf|image\/png|image\/jpeg|text\/plain|text\/csv|application\/csv)$/.test(
            attachment.contentType,
          )
        ) {
          const filename =
            attachment.filename ||
            `receipt.${attachment.contentType === "application/pdf" ? "pdf" : attachment.contentType === "image/png" ? "png" : attachment.contentType === "image/jpeg" ? "jpg" : /^(text|application)\/csv$/.test(attachment.contentType) ? "csv" : "txt"}`;
          const result = await storeReceipt(
            attachment.content,
            filename,
            order ? "wolt" : "unknown",
            "email",
            order || undefined,
          );
          ids.push(result.id);
        }
      }
      if (text) bodyParts.push(text);
    };
    await collect(email);
    if (!ids.length && bodyParts.length) {
      const text = bodyParts.join("\n");
      if (
        /rimi|selver|partnerkaart|coop|lidl|delice/i.test(text) &&
        /\b(kokku|total|tasuda|maksta|summe)\b/i.test(text)
      ) {
        const result = await storeReceipt(
          Buffer.from(text),
          `${digest(text)}.txt`,
          "unknown",
          "email",
        );
        ids.push(result.id);
      }
    }
    await query(
      `UPDATE inbound_emails SET sender=$2,subject=$3,message_id=$4,receipt_ids=$5,status=$6,
      error=$7,processed_at=now() WHERE id=$1`,
      [
        id,
        email.from?.text?.slice(0, 500) || null,
        email.subject?.slice(0, 500) || null,
        email.messageId || null,
        JSON.stringify([...new Set(ids)]),
        ids.length ? "complete" : "review",
        ids.length
          ? null
          : "No receipt attachment or readable receipt body was found. Export the receipt from the retailer and upload it.",
      ],
    );
  } catch {
    await query(
      "UPDATE inbound_emails SET status='error',error=$2,processed_at=now() WHERE id=$1",
      [
        id,
        "The email could not be processed. Retry or download the original message.",
      ],
    );
    throw new AppError("The email could not be processed.", 502);
  }
}
export type EmailConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password?: string;
  accessToken?: string;
  folder: string;
  enabled: boolean;
  lastUid?: number;
  uidValidity?: string;
};
export async function syncImap() {
  const [setting] = await query("SELECT value FROM settings WHERE key='imap'");
  if (!setting?.value?.cipher) return;
  const options = decrypt<EmailConfig>(setting.value.cipher);
  if (!options.enabled) return;
  const [run] = await query(
    "INSERT INTO import_runs(type) VALUES('email') RETURNING id",
  );
  await query(
    "UPDATE settings SET value=jsonb_set(value,'{lastAttemptAt}',to_jsonb($1::text)) WHERE key='imap'",
    [new Date().toISOString()],
  );
  const client = new ImapFlow({
    host: options.host,
    port: options.port,
    secure: options.secure,
    auth: {
      user: options.user,
      ...(options.accessToken
        ? { accessToken: options.accessToken }
        : { pass: options.password! }),
    },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
  });
  let count = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock(options.folder, {
      readOnly: true,
    });
    try {
      const validity = client.mailbox && String(client.mailbox.uidValidity);
      const lastUid =
        validity === options.uidValidity ? options.lastUid || 0 : 0;
      const uids = await client.search(
        lastUid
          ? { uid: `${lastUid + 1}:*` }
          : { since: new Date(Date.now() - 30 * 86400000) },
        { uid: true },
      );
      if (uids)
        for (const uid of uids.filter((uid) => uid > lastUid).slice(0, 100)) {
          const message = await client.fetchOne(
            uid,
            { source: true },
            { uid: true },
          );
          if (!message || !message.source) continue;
          if (message.source.length > MAX_EMAIL_SIZE)
            throw new AppError(
              "A mailbox email exceeds the 20 MB limit. Remove it from the receipt folder or import a smaller attachment.",
            );
          await receiveEmail(message.source);
          count++;
          options.lastUid = uid;
          options.uidValidity = validity || undefined;
        }
    } finally {
      lock.release();
    }
    const { encrypt } = await import("./crypto");
    await query(
      "UPDATE settings SET value=$1,updated_at=now() WHERE key='imap'",
      [
        JSON.stringify({
          cipher: encrypt(options),
          lastSyncAt: new Date().toISOString(),
          lastAttemptAt: new Date().toISOString(),
          error: null,
        }),
      ],
    );
    await query(
      "UPDATE import_runs SET status='complete',count=$2,finished_at=now() WHERE id=$1",
      [run.id, count],
    );
  } catch (error) {
    const message =
      error instanceof AppError
        ? error.message
        : "Could not connect to the receipt mailbox. Check the host, folder, and app password or access token.";
    await query(
      "UPDATE settings SET value=jsonb_set(value,'{error}',to_jsonb($1::text)) WHERE key='imap'",
      [message],
    );
    await query(
      "UPDATE import_runs SET status='error',error=$2,finished_at=now() WHERE id=$1",
      [run.id, message],
    );
    throw new AppError(message, 502);
  } finally {
    await client.logout().catch(() => {});
  }
}
