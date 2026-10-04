import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import { emailMessage } from "../../src/lib/email-message";

async function parse(
  body: string,
  contentType = "text/plain",
  subject = "Gmail Forwarding Confirmation",
) {
  return emailMessage(
    await simpleParser(
      Buffer.from(
        `From: Gmail Team <forwarding-noreply@google.com>\r\nSubject: ${subject}\r\nContent-Type: ${contentType}; charset=utf-8\r\n\r\n${body}`,
      ),
      { skipHtmlToText: true, skipTextToHtml: true },
    ),
  );
}

describe("forwarding confirmation messages", () => {
  it("reads Gmail's code and confirmation link", async () => {
    expect(
      (
        await parse(
          "Confirmation code: 012345678\nTo allow forwarding visit https://mail.google.com/mail/vf-test-token",
        )
      ).verification,
    ).toEqual({
      code: "012345678",
      url: "https://mail.google.com/mail/vf-test-token",
    });
  });
  it("reads HTML-only messages without rendering HTML or loading images", async () => {
    const message = await parse(
      '<p>Verification code: 123456</p><a href="https://mail.google.com/mail/vf-token">Confirm</a><img src="https://tracker.example/pixel">',
      "text/html",
    );
    expect(message.verification).toEqual({
      code: "123456",
      url: "https://mail.google.com/mail/vf-token",
    });
    expect(message.text).not.toContain("<p>");
    expect(message.text).not.toContain("tracker.example");
  });
  it.each([
    "https://mail.google.com.evil.example/mail/vf-token",
    "https://mail.google.com@evil.example/mail/vf-token",
    "https://mail.google.com/mail/uf-token",
    "https://mail.google.com:444/mail/vf-token",
    "javascript:alert(1)",
  ])("does not offer a Gmail confirmation action for %s", async (url) => {
    expect(
      (await parse(`Confirm forwarding: ${url}`)).verification?.url,
    ).toBeNull();
  });
  it("keeps unrelated receipts out of verification", async () => {
    expect(
      (
        await parse(
          "Thank you for forwarding your receipt. Please confirm delivery. Total: 10.00",
          "text/plain",
          "Your receipt",
        )
      ).verification,
    ).toBeNull();
  });
  it("supports other providers' codes and messages without a code", async () => {
    expect(
      (
        await parse(
          "Verification code: 123456",
          "text/plain",
          "Verify forwarding address",
        )
      ).verification?.code,
    ).toBe("123456");
    expect(
      (
        await parse(
          "Click the link to confirm.",
          "text/plain",
          "Forwarding confirmation",
        )
      ).verification,
    ).toEqual({ code: null, url: null });
  });
});
