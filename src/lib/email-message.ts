import type { ParsedMail } from "mailparser";
import { convert } from "html-to-text";

export type EmailMessage = {
  subject: string;
  sender: string;
  text: string;
  verification: { code: string | null; url: string | null } | null;
};

// Display untrusted mail as text; never render its HTML or load remote images.
export function emailMessage(email: ParsedMail): EmailMessage {
  const htmlText = email.html
    ? convert(email.html, {
        wordwrap: false,
        selectors: [{ selector: "img", format: "skip" }],
      })
    : "";
  const text = email.text || htmlText;
  const subject = email.subject || "Email";
  const forwarding =
    (/\bforwarding\b/i.test(subject) &&
      /\b(confirm(?:ation)?|verif(?:y|ication))\b/i.test(subject)) ||
    (/\bforwarding\b/i.test(text) &&
      /\b(?:confirmation|verification)\s+code\s*[:：]?\s*\d{4,12}\b/i.test(
        text,
      ));
  let url: string | null = null;
  if (forwarding) {
    for (const candidate of `${text}\n${htmlText}`.matchAll(
      /https:\/\/[^\s<>\[\]"]+/g,
    )) {
      try {
        const parsed = new URL(candidate[0]);
        if (
          parsed.hostname === "mail.google.com" &&
          !parsed.username &&
          !parsed.password &&
          !parsed.port &&
          parsed.pathname.startsWith("/mail/vf-")
        ) {
          url = parsed.href;
          break;
        }
      } catch {
        /* Invalid links remain plain text. */
      }
    }
  }
  return {
    subject,
    sender: email.from?.text || "Unknown sender",
    text,
    verification: forwarding
      ? {
          code:
            /\b(?:confirmation|verification)\s+code\s*[:：]?\s*(\d{4,12})\b/i.exec(
              text,
            )?.[1] || null,
          url,
        }
      : null,
  };
}
