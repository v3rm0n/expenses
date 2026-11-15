import { describe, expect, it, vi } from "vitest";
import worker from "../../integrations/cloudflare/worker.js";

function message(from: string) {
  return {
    from,
    rawSize: 10,
    raw: new Blob(["Subject: receipt\r\n\r\nbody"]).stream(),
    setReject: vi.fn(),
  };
}
const env = (allowed: string) => ({
  ALLOWED_SENDERS: allowed,
  APP_URL: "https://expenses.example.com",
  INBOUND_EMAIL_TOKEN: "test",
  EMAIL_INBOX: { put: vi.fn(), delete: vi.fn() },
});

describe("receipt email bridge senders", () => {
  it.each([
    ["me+caf_=receipts=receipts.example.com@gmail.com", "me@gmail.com"],
    ["me@gmail.com", "me@gmail.com"],
    ["shop@example.com", "me@gmail.com, @example.com"],
    ["anyone@example.net", ""],
  ])("accepts %s for %s", async (from, allowed) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 202 })),
    );
    const mail = message(from),
      settings = env(allowed);
    await worker.email(mail, settings);
    expect(mail.setReject).not.toHaveBeenCalled();
    expect(settings.EMAIL_INBOX.put).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
  it.each([
    ["meme@gmail.com", "me@gmail.com"],
    ["attacker@example.net", "me@gmail.com, @example.com"],
    ["x@sub.example.com", "@example.com"],
  ])("rejects %s for %s before storing it", async (from, allowed) => {
    const mail = message(from),
      settings = env(allowed);
    await worker.email(mail, settings);
    expect(mail.setReject).toHaveBeenCalledOnce();
    expect(settings.EMAIL_INBOX.put).not.toHaveBeenCalled();
  });
});
