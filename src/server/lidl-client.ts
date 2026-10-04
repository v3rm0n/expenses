import { chromium, type BrowserContext } from "playwright";
import { convert } from "html-to-text";
import { z } from "zod";
import { parseLidlReceipt } from "../lib/lidl-receipt";
import { parseMoney } from "../lib/money";
import { AppError } from "./errors";

const origin = "https://www.lidl.ee";
const ticketId = z.string().regex(/^[a-zA-Z0-9-]{1,100}$/);
const ticketPage = z.object({
  page: z.number().int().positive(),
  size: z.number().int().positive(),
  totalCount: z.number().int().nonnegative(),
  items: z.array(
    z.object({
      id: ticketId,
      totalAmount: z.number().finite(),
      badges: z.object({ isAvailable: z.boolean() }),
    }),
  ),
});
export type LidlSession = Awaited<ReturnType<BrowserContext["storageState"]>>;
export type LidlOptions = {
  user: string;
  password: string;
  enabled: boolean;
  session?: LidlSession;
};
export interface LidlTransport {
  json(path: string): Promise<unknown>;
}

export function lidlReceiptText(detail: unknown, id: string, total: number) {
  const result = z
    .object({
      ticket: z.object({
        id: ticketId,
        isDeleted: z.boolean(),
        htmlPrintedReceipt: z
          .string()
          .min(1)
          .max(2 * 1024 * 1024),
      }),
    })
    .parse(detail);
  if (result.ticket.id !== id || result.ticket.isDeleted)
    throw new AppError(
      "Lidl returned an unavailable or different receipt.",
      502,
    );
  // Preserve the printed rows inside <pre>; never render retailer HTML in the app.
  const text = convert(result.ticket.htmlPrintedReceipt, {
    wordwrap: false,
    selectors: [{ selector: "img", format: "skip" }],
  })
    .replace(/\r\n/g, "\n")
    .trim();
  const parsed = parseLidlReceipt(text);
  if (
    !parsed ||
    parsed.total === null ||
    parsed.total !== parseMoney(total, "EUR")
  )
    throw new AppError(
      "The Lidl receipt does not agree with its purchase-history total. Import its original manually for review.",
      502,
    );
  return text;
}

export async function importLidlHistory(
  transport: LidlTransport,
  hasReceipt: (id: string) => Promise<boolean>,
  save: (id: string, text: string) => Promise<void>,
) {
  const seen = new Set<string>();
  let count = 0;
  for (let page = 1; page <= 1000; page++) {
    const result = ticketPage.parse(
      await transport.json(`/mre/api/v1/tickets?country=EE&page=${page}`),
    );
    if (result.page !== page || result.items.length > result.size)
      throw new AppError(
        "Lidl returned an unexpected receipt-history page.",
        502,
      );
    for (const item of result.items) {
      if (seen.has(item.id))
        throw new AppError(
          "Lidl repeated a receipt-history page. Retry the import.",
          502,
        );
      seen.add(item.id);
      if (!item.badges.isAvailable || (await hasReceipt(item.id))) continue;
      const detail = await transport.json(
        `/mre/api/v1/tickets/${encodeURIComponent(item.id)}?country=EE&languageCode=et-EE`,
      );
      await save(item.id, lidlReceiptText(detail, item.id, item.totalAmount));
      count++;
    }
    if (page * result.size >= result.totalCount) return count;
    if (!result.items.length)
      throw new AppError(
        "Lidl receipt history ended before all purchases were fetched. Retry the import.",
        502,
      );
  }
  throw new AppError("Lidl receipt history exceeded the import limit.", 502);
}

export async function openLidl(options: LidlOptions, interactive = false) {
  let stage = "starting Chromium";
  const browser = await chromium
    .launch({
      headless: !interactive,
      ...(process.env.LIDL_BROWSER_EXECUTABLE_PATH
        ? { executablePath: process.env.LIDL_BROWSER_EXECUTABLE_PATH }
        : {}),
    })
    .catch(() => {
      throw new AppError(
        "Chromium could not start. Install it with npx playwright install chromium, or configure LIDL_BROWSER_EXECUTABLE_PATH.",
        502,
      );
    });
  try {
    const context = await browser.newContext({
      storageState: options.session,
      locale: "et-EE",
    });
    context.setDefaultTimeout(15000);
    const get = async (path: string) => {
      const response = await context.request.get(`${origin}${path}`, {
        timeout: 30000,
        maxRedirects: 0,
      });
      return response;
    };
    const authenticated = async () => {
      const response = await get("/mre/api/v1/tickets?country=EE&page=1");
      return (
        response.ok() &&
        ticketPage.safeParse(await response.json().catch(() => null)).success
      );
    };
    if (!(await authenticated())) {
      stage = "opening the Lidl login page";
      const page = await context.newPage();
      await page.goto(
        `${origin}/user-api/login?redirect=%2Fmla%2F&step=login`,
        { waitUntil: "domcontentloaded", timeout: 60000 },
      );
      if (new URL(page.url()).hostname !== "accounts.lidl.com")
        throw new AppError("Lidl did not open its expected sign-in page.", 502);
      const reject = page.locator('[data-testid="cookie-banner-reject-btn"]');
      await reject
        .waitFor({ state: "visible", timeout: 5000 })
        .then(() => reject.click())
        .catch(() => {});
      stage = "entering the email address";
      await page.locator("#input-email").fill(options.user);
      await page
        .locator('[data-testid="login-or-register-submit-button"]')
        .click();
      stage = "entering the password";
      await page.locator('input[type="password"]').fill(options.password);
      await page.locator('[data-testid="button-primary"]').click();
      stage = "waiting for Lidl to finish sign-in";
      await page.waitForURL(`${origin}/**`, {
        timeout: interactive ? 180000 : 60000,
      });
      await page.close();
      if (!(await authenticated()))
        throw new AppError(
          "Lidl sign-in did not grant access to digital receipts.",
          502,
        );
    }
    return {
      async json(path: string) {
        const response = await get(path);
        if (!response.ok())
          throw new AppError(
            "Lidl could not return receipt history. Check the account connection and retry.",
            502,
          );
        const body = await response.body();
        if (body.length > 2 * 1024 * 1024)
          throw new AppError(
            "The Lidl response exceeds the import limit.",
            502,
          );
        try {
          return JSON.parse(body.toString());
        } catch {
          throw new AppError(
            "Lidl returned an unexpected response. Reconnect and retry.",
            502,
          );
        }
      },
      session: () => context.storageState(),
      close: () => browser.close(),
    };
  } catch (error) {
    await browser.close();
    if (error instanceof AppError) throw error;
    throw new AppError(
      `Lidl sign-in stopped while ${stage}. Check your credentials or use npm run lidl:connect -- --interactive to complete verification.`,
      502,
    );
  }
}
