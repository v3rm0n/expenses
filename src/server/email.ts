import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { simpleParser } from "mailparser";
import { convert } from "html-to-text";
import { digest } from "./crypto";
import { query } from "./db";
import { AppError } from "./errors";
import { enqueue } from "./queue";
import { MAX_FILE_SIZE, storeReceipt, storageFile } from "./receipts";
import { woltEmailOrder } from "../lib/wolt-receipt";
import { emailMessage } from "../lib/email-message";

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
  if (!["complete", "review", "verification"].includes(email.status))
    await enqueue("email-parse", { emailId: email.id }, email.id);
  return { id: email.id, status: email.status };
}
export async function processEmail(id: string) {
  const [row] = await query("SELECT * FROM inbound_emails WHERE id=$1", [id]);
  if (!row || ["complete", "review", "verification"].includes(row.status))
    return;
  const ids: string[] = [];
  try {
    const raw = await readFile(storageFile(row.storage_path));
    const email = await simpleParser(raw, {
      skipHtmlToText: true,
      skipTextToHtml: true,
    });
    if (emailMessage(email).verification) {
      await query(
        "UPDATE inbound_emails SET sender=$2,subject=$3,message_id=$4,receipt_ids='[]',status='verification',error=NULL,processed_at=now() WHERE id=$1",
        [
          id,
          email.from?.text?.slice(0, 500) || null,
          email.subject?.slice(0, 500) || null,
          email.messageId || null,
        ],
      );
      return;
    }
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
export async function readEmailMessage(id: string) {
  const [row] = await query(
    "SELECT storage_path FROM inbound_emails WHERE id=$1",
    [id],
  );
  if (!row) throw new AppError("Email not found.", 404);
  return emailMessage(
    await simpleParser(await readFile(storageFile(row.storage_path)), {
      skipHtmlToText: true,
      skipTextToHtml: true,
    }),
  );
}
