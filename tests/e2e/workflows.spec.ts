import { test, expect, type Cookie, type Page } from "@playwright/test";
import { decimalMoney } from "../../src/lib/money";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  receiptText,
  amazonOrderId,
  amazonReceiptText,
  textPdf,
} from "../fixtures";
const password = "only-for-isolated-test-db";
let ownerCookies: Cookie[] = [];
async function signInOwner(page: Page) {
  if (ownerCookies.length) await page.context().addCookies(ownerCookies);
  const status = await (await page.request.get("/api/auth/status")).json();
  if (!status.authenticated) {
    const response = await page.request.post(
      status.needsSetup ? "/api/auth/setup" : "/api/auth/login",
      {
        headers: { Origin: "http://127.0.0.1:4318" },
        data: status.needsSetup
          ? {
              name: "Test owner",
              password,
              token: "expenses-test-setup-token-only",
            }
          : { password },
      },
    );
    expect(response.ok()).toBe(true);
    ownerCookies = await page.context().cookies();
  }
  return status;
}
test.describe.configure({ mode: "serial" });
test("owner setup, cash ledger, receipt corrections and mobile overview", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/setup?token=expenses-test-setup-token-only");
  await page.getByLabel("Your name").fill("Test owner");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  ownerCookies = await page.context().cookies();
  const today = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Tallinn",
  }).format(new Date());
  await page.getByRole("button", { name: "Transactions", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Transactions", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cash entry", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const dateField = dialog.getByLabel("Date", { exact: true });
  await expect(dateField).toHaveAttribute("type", "text");
  await expect(dateField).toHaveValue(today);
  const dateLabel = dialog.locator(".date-input-label").first();
  const namedDate = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${today}T12:00:00Z`));
  await expect(dateLabel).toHaveAttribute("data-label", namedDate);
  await expect(dateLabel).toBeVisible();
  await dateField.focus();
  await expect(dateLabel).toBeHidden();
  await expect(dateField).toHaveValue(today);
  await dateField.blur();
  await expect(dateLabel).toBeVisible();
  await dateField.fill("2026-02-30");
  expect(
    await dateField.evaluate((element: HTMLInputElement) =>
      element.checkValidity(),
    ),
  ).toBe(false);
  await dateField.fill("10/05/2026");
  expect(
    await dateField.evaluate((element: HTMLInputElement) =>
      element.checkValidity(),
    ),
  ).toBe(false);
  await dateField.fill(today);
  expect(
    await dateField.evaluate((element: HTMLInputElement) =>
      element.checkValidity(),
    ),
  ).toBe(true);
  const calendar = dialog.getByLabel("Choose date", { exact: true });
  await expect(calendar).toHaveAttribute("type", "date");
  // Confirm clicking the calendar invokes the browser picker, then exercise
  // the native date input's selection event and its ISO text synchronization.
  await calendar.evaluate((element: HTMLInputElement) => {
    const showPicker = element.showPicker.bind(element);
    element.showPicker = () => {
      element.dataset.opened = "true";
      showPicker();
    };
  });
  await calendar.click();
  await expect(calendar).toHaveAttribute("data-opened", "true");
  await page.keyboard.press("Escape");
  await calendar.fill(`${today.slice(0, 7)}-02`);
  await expect(dateField).toHaveValue(`${today.slice(0, 7)}-02`);
  await calendar.fill(today);
  await expect(dateField).toHaveValue(today);
  await dialog.getByLabel("Merchant or description").fill("Market purchase");
  await dialog.getByLabel("Amount", { exact: true }).fill("12.34");
  await dialog
    .getByRole("combobox", { name: "Category", exact: true })
    .selectOption("groceries");
  await dialog.getByRole("button", { name: "Record entry" }).click();
  await expect(
    page.getByRole("button", { name: /Market purchase/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Market purchase/ }).click();
  await expect(page.getByText(namedDate, { exact: true })).toBeVisible();
  await page.getByLabel("Category 1", { exact: true }).selectOption("gifts");
  await page.getByLabel("Personal note").fill("Changed by the owner");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toHaveText("Transaction updated.");
  await page.getByRole("button", { name: "Receipts", exact: true }).click();
  await page.getByLabel("Receipt files").setInputFiles({
    name: "rimi.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(receiptText()),
  });
  await page.getByRole("button", { name: "Import receipts" }).click();
  await expect(
    page.getByRole("button", { name: /Rimi.*rimi.txt/ }),
  ).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: /Rimi.*rimi.txt/ }).click();
  await expect(
    page.getByRole("button", { name: "Edit receipt" }),
  ).toBeVisible();
  await expect(page.getByText("Pesuvahend", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole("button", { name: "Edit receipt" }).click();
  await page.getByLabel("Product category 2").selectOption("health");
  await page.getByRole("button", { name: "Save and validate" }).click();
  await expect(
    page.getByRole("button", { name: "Edit receipt" }),
  ).toBeVisible();
  await expect(
    page.locator(".product-table").getByText("Health", { exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Record cash payment" }).click();
  await expect(
    page.getByText("This receipt is fully accounted for."),
  ).toBeVisible();
  await page.goto("/receipts?retailer=rimi&page=1");
  await page.getByRole("button", { name: /Rimi.*rimi.txt/ }).click();
  await page.getByRole("button", { name: "All receipts", exact: true }).click();
  await expect(page).toHaveURL(/\/receipts\?retailer=rimi&page=1$/);
  await expect(page.getByLabel("Filter retailer")).toHaveValue("rimi");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Receipt email bridge" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Connect an existing mailbox" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Reveal bridge token" }).click();
  await expect(page.locator(".secret-field")).toHaveText(
    "expenses-test-email-token-only",
  );
  await page.getByRole("button", { name: "Hide bridge token" }).click();
  const verification = await page.request.post("/api/inbound/email", {
    headers: {
      Authorization: "Bearer expenses-test-email-token-only",
      "Content-Type": "message/rfc822",
    },
    data: "From: forwarding-noreply@google.com\r\nSubject: Gmail Forwarding Confirmation\r\nContent-Type: text/plain\r\n\r\nConfirmation code: 012345678\nhttps://mail.google.com/mail/vf-test-token",
  });
  expect(verification.status()).toBe(202);
  await page.reload();
  const verificationRow = page
    .getByRole("row")
    .filter({ hasText: "Gmail Forwarding Confirmation" });
  await expect(
    verificationRow.getByText("verification", { exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await verificationRow.getByRole("button", { name: "Open message" }).click();
  await expect(page.locator(".email-message code")).toHaveText("012345678");
  await expect(
    page.getByRole("link", { name: "Open Gmail confirmation" }),
  ).toHaveAttribute("href", "https://mail.google.com/mail/vf-test-token");
  await expect(
    verificationRow.getByRole("button", { name: "Retry" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Close message" }).click();
  await page.getByRole("button", { name: "Rules", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Create a rule" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page
    .getByLabel("Period ending", { exact: true })
    .fill(today.slice(0, 7));
  await mkdir(".data/screenshots", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: ".data/screenshots/desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".data/screenshots/phone.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: /^Review(?: \d+)?$/ }).click();
  await expect(
    page.getByRole("heading", { name: "Review", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("authentication, CSRF, email bearer token and idempotent cash imports", async ({
  request,
}) => {
  expect((await request.get("/api/transactions")).status()).toBe(401);
  expect(
    (await request.post("/api/auth/login", { data: { password } })).status(),
  ).toBe(403);
  expect(
    (
      await request.post("/api/auth/login", {
        data: { password },
        headers: { Origin: "http://127.0.0.1:4318" },
      })
    ).status(),
  ).toBe(200);
  const settings = await (await request.get("/api/settings")).json();
  expect(settings).not.toHaveProperty("mailbox");
  for (const route of ["/api/settings/mailbox", "/api/settings/mailbox/sync"])
    expect(
      (
        await request.post(route, {
          headers: { Origin: "http://127.0.0.1:4318" },
          data: {},
        })
      ).status(),
    ).toBe(404);
  const payload = {
    merchant: "Repeated request",
    amount: "1.00",
    currency: "USD",
    date: "2026-10-02",
    category: "groceries",
    kind: "expense",
    idempotencyKey: randomUUID(),
  };
  expect(
    (
      await request.post("/api/transactions", {
        data: payload,
        headers: { Origin: "https://wrong.example" },
      })
    ).status(),
  ).toBe(403);
  const send = () =>
    request.post("/api/transactions", {
      data: payload,
      headers: { Origin: "http://127.0.0.1:4318" },
    });
  const first = await send(),
    second = await send();
  expect(first.status()).toBe(201);
  expect((await first.json()).id).toBe((await second.json()).id);
  const summary = await (
    await request.get("/api/overview?month=2026-10&currency=USD")
  ).json();
  expect(summary.spending).toBe(100);
  expect(
    (await request.post("/api/inbound/email", { data: "mail" })).status(),
  ).toBe(401);
  const raw = `From: sender@example.com\r\nSubject: Receipt\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${receiptText("Coop", "api-mail")}`;
  expect(
    (
      await request.post("/api/inbound/email", {
        data: raw,
        headers: {
          Authorization: "Bearer expenses-test-email-token-only",
          "Content-Type": "message/rfc822",
        },
      })
    ).status(),
  ).toBe(202);
  const response = await request.get("/api/export?type=expenses");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/csv");
  expect(
    (
      await request.post("/api/auth/setup", {
        data: {
          name: "Other",
          password,
          token: "expenses-test-setup-token-only",
        },
        headers: { Origin: "http://127.0.0.1:4318" },
      })
    ).status(),
  ).toBe(409);
});

test("overview combines investment and pension analysis and fits a phone", async ({
  page,
}) => {
  const headers = { Origin: "http://127.0.0.1:4318" };
  expect(
    (
      await page.request.post("/api/auth/login", {
        data: { password },
        headers,
      })
    ).status(),
  ).toBe(200);
  const today = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Tallinn",
  }).format(new Date());
  for (const [kind, merchant, amount] of [
    ["investment", "Test broker", "100.00"],
    ["pension", "Test pension provider", "50.00"],
  ]) {
    const created = await page.request.post("/api/transactions", {
      headers,
      data: {
        merchant,
        amount,
        currency: "GBP",
        date: today,
        category: "uncategorized",
        kind: "expense",
        idempotencyKey: randomUUID(),
      },
    });
    expect(created.status()).toBe(201);
    const { id } = await created.json();
    await page.goto(`/transactions/${id}`);
    await page
      .getByRole("combobox", { name: "Payment type", exact: true })
      .selectOption(kind);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toHaveText("Transaction updated.");
  }
  const summary = await (
    await page.request.get(
      `/api/overview?month=${today.slice(0, 7)}&currency=GBP`,
    )
  ).json();
  expect(summary.spending).toBe(0);
  expect(summary.investment.contributed).toBe(10000);
  expect(summary.pension.contributed).toBe(5000);
  expect(summary.net_cash_flow).toBe(-15000);
  await page.goto("/");
  await page.getByLabel("Currency", { exact: true }).selectOption("GBP");
  await page.getByLabel("Period length").selectOption("6");
  const section = page.locator(".contributions-panel");
  await expect(
    section.getByRole("heading", { name: "Investments and pensions" }),
  ).toBeVisible();
  await expect(section.locator(".metric-value").nth(0)).toHaveText("£100.00");
  await expect(section.locator(".metric-value").nth(1)).toHaveText("£50.00");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: ".data/screenshots/contributions-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".data/screenshots/contributions-phone.png",
    fullPage: true,
  });
  await section.getByRole("button", { name: "View transfers" }).first().click();
  await expect(page.getByLabel("Filter payment type")).toHaveValue(
    "investment",
  );
  await expect(page.getByRole("button", { name: /Test broker/ })).toBeVisible();
});

test("filters survive detail navigation, CSV matches results, and mobile amounts stay visible", async ({
  page,
}) => {
  const headers = { Origin: "http://127.0.0.1:4318" };
  await page.request.post("/api/auth/login", { data: { password }, headers });
  const today = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Tallinn",
  }).format(new Date());
  const prefix = `Filter regression ${randomUUID().slice(0, 8)}`;
  for (let i = 0; i < 54; i++) {
    const response = await page.request.post("/api/transactions", {
      headers,
      data: {
        merchant: `${prefix} ${i}`,
        amount: i === 52 ? "90.00" : "10.00",
        currency: "CHF",
        date: today,
        category: i === 53 ? "gifts" : "groceries",
        kind: "expense",
        idempotencyKey: randomUUID(),
      },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto(`/transactions?month=${today.slice(0, 7)}&currency=CHF`);
  await page.getByRole("button", { name: "All history", exact: true }).click();
  await expect(page.getByLabel("Month", { exact: true })).toHaveCount(0);
  await page.getByLabel("Search transactions").fill(prefix);
  await page.getByLabel("Filter category").selectOption("groceries");
  const account = await page
    .getByLabel("Filter account")
    .locator("option")
    .filter({ hasText: "Cash" })
    .evaluateAll((options) =>
      options
        .find((option) => option.textContent?.includes("CHF"))
        ?.getAttribute("value"),
    );
  expect(account).toBeTruthy();
  await page.getByLabel("Filter account").selectOption(account!);
  await page.getByLabel("Filter payment type").selectOption("expense");
  await page.getByLabel("Filter receipt status").selectOption("missing");
  await page.getByLabel("Filter booking status").selectOption("BOOK");
  await page.getByLabel("Minimum amount").fill("9");
  await page.getByLabel("Maximum amount").fill("11");
  await expect(page.locator(".pagination")).toContainText("of 52");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.locator(".pagination")).toContainText("Page 2");
  const listUrl = page.url();
  const exportUrl = await page
    .getByRole("link", { name: "Export CSV" })
    .getAttribute("href");
  const exported = await page.request.get(exportUrl!);
  expect(exported.status()).toBe(200);
  const csv = await exported.text();
  expect(csv.trim().split("\n")).toHaveLength(53);
  expect(csv).not.toContain(`"${prefix} 52"`);
  expect(csv).not.toContain(`"${prefix} 53"`);
  await page.locator(".entry-table .merchant-link").first().click();
  await expect(page.getByLabel("Currency", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Month", { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "All transactions", exact: true })
    .click();
  await expect(page).toHaveURL(listUrl);
  await expect(page.locator(".pagination")).toContainText("Page 2");
  await expect(page.getByLabel("Search transactions")).toHaveValue(prefix);
  await expect(page.getByLabel("Filter account")).toHaveValue(account!);
  await expect(page.getByLabel("Maximum amount")).toHaveValue("11");
  await page.reload();
  await expect(page.locator(".pagination")).toContainText("Page 2");
  await page.locator(".entry-table .merchant-link").first().click();
  await expect(
    page.getByRole("heading", { name: "Transaction details", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(listUrl);
  await expect(page.locator(".pagination")).toContainText("Page 2");
  await page.setViewportSize({ width: 390, height: 844 });
  const amounts = await page
    .locator(".entry-table .entry-amount")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width };
      }),
    );
  expect(amounts.length).toBe(2);
  expect(
    amounts.every(
      (rect) => rect.left >= 0 && rect.right <= 390 && rect.width > 0,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".data/screenshots/transactions-phone.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page.locator(".contributions-panel")).toHaveCount(0);
  const monthCalendar = page.getByLabel("Choose month", { exact: true });
  await expect(monthCalendar).toHaveAttribute("type", "month");
  await monthCalendar.fill("2026-08");
  await page.reload();
  await expect(page.getByLabel("Period ending", { exact: true })).toHaveValue(
    "2026-08",
  );
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Receipts", exact: true }).click();
  await expect(page.getByLabel("Currency", { exact: true })).toHaveCount(0);
});

test("Lidl connection settings keep passwords private and support pause and disconnect", async ({
  page,
}) => {
  const headers = { Origin: "http://127.0.0.1:4318" };
  await page.request.post("/api/auth/login", { data: { password }, headers });
  await page.goto("/settings");
  await page
    .getByLabel("Lidl email", { exact: true })
    .fill("lidl-test@example.com");
  await page
    .getByLabel("Lidl password", { exact: true })
    .fill("private-lidl-test-password");
  await page.getByLabel("Import receipts daily", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Save Lidl connection" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Lidl automatic imports paused.",
  );
  await expect(page.getByLabel("Lidl password", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    page.getByRole("button", { name: "Import now", exact: true }),
  ).toBeDisabled();
  const settings = await (await page.request.get("/api/settings")).json();
  expect(settings.lidl).toMatchObject({
    user: "lidl-test@example.com",
    enabled: false,
    hasPassword: true,
  });
  expect(JSON.stringify(settings)).not.toContain("private-lidl-test-password");
  expect(settings.lidl).not.toHaveProperty("cipher");
  expect(settings.lidl).not.toHaveProperty("session");
  await page.getByRole("button", { name: "Save Lidl connection" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Lidl automatic imports paused.",
  );
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Lidl disconnected. Imported receipts are retained.",
  );
  expect(
    (await (await page.request.get("/api/settings")).json()).lidl,
  ).toBeNull();
});

test("bulk categorization spans history, keeps each amount and preserves manual corrections", async ({
  page,
}) => {
  const headers = { Origin: "http://127.0.0.1:4318" };
  await page.request.post("/api/auth/login", { data: { password }, headers });
  const merchant = `Bulk test ${randomUUID().slice(0, 8)}`;
  const create = async (
    amount: string,
    date: string,
    automatic: boolean,
    currency = "EUR",
    kind = "expense",
  ) => {
    const response = await page.request.post("/api/transactions", {
      headers,
      data: {
        merchant,
        amount,
        date,
        currency,
        kind,
        category: "uncategorized",
        idempotencyKey: randomUUID(),
      },
    });
    expect(response.status()).toBe(201);
    const { id } = await response.json();
    if (automatic) {
      const reset = await page.request.post(`/api/transactions/${id}`, {
        headers,
        data: { kind, automatic: true },
      });
      expect(reset.ok()).toBe(true);
    }
    return id;
  };
  const source = await create("3.00", "2026-10-01", false);
  const peer = await create("4.50", "2026-09-01", true);
  const manual = await create("7.00", "2026-08-01", false);
  const foreign = await create("5.00", "2026-07-01", true, "USD");
  const refund = await create("2.00", "2026-06-01", true, "EUR", "refund");
  const linked = await create("5.10", "2026-10-02", true);
  const upload = await page.request.post("/api/receipts/upload", {
    headers,
    multipart: {
      files: {
        name: "bulk-receipt.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(receiptText("Rimi", `bulk-${randomUUID()}`)),
      },
    },
  });
  const receiptId = (await upload.json()).results[0].id;
  expect(receiptId).toBeTruthy();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/receipts/${receiptId}`)).json())
          .status,
    )
    .toBe("ready");
  const link = await page.request.post(`/api/receipts/${receiptId}/link`, {
    headers,
    data: { transactionId: linked, amount: "5.10" },
  });
  expect(link.ok()).toBe(true);
  const detail = async (id: string) =>
    (await page.request.get(`/api/transactions/${id}`)).json();
  const protectedIds = [manual, foreign, refund, linked];
  const before = await Promise.all(protectedIds.map(detail));
  await page.goto(`/transactions/${source}`);
  await page
    .getByLabel("Category 1", { exact: true })
    .selectOption("subscriptions");
  await page
    .getByLabel("Apply category to similar transactions", { exact: true })
    .check();
  await expect(
    page.getByText(
      "1 other matching transactions will be categorized on save.",
    ),
  ).toBeVisible();
  await page
    .getByLabel("Include manually categorized transactions", { exact: true })
    .check();
  await expect(
    page.getByText(
      "2 other matching transactions will be categorized on save.",
    ),
  ).toBeVisible();
  await page
    .getByLabel("Include manually categorized transactions", { exact: true })
    .uncheck();
  await expect(
    page.getByText(
      "1 other matching transactions will be categorized on save.",
    ),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Save and categorize 2 transactions",
      exact: true,
    })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "2 transactions categorized.",
  );
  expect((await detail(source)).allocations).toMatchObject([
    { category_id: "subscriptions", amount: 300, source: "manual" },
  ]);
  const matched = await detail(peer);
  expect(matched.allocations).toMatchObject([
    { category_id: "subscriptions", amount: 450, source: "manual" },
  ]);
  expect(matched.manual).toBe(true);
  for (const [index, id] of protectedIds.entries()) {
    const after = await detail(id);
    expect(after.allocations).toEqual(before[index].allocations);
    expect(after.kind).toBe(before[index].kind);
    expect(after.receipts).toEqual(before[index].receipts);
  }
  const invalid = await page.request.post(`/api/transactions/${source}`, {
    headers,
    data: {
      kind: "expense",
      allocations: [{ category_id: "gifts", amount: "2.00" }],
      similarPattern: "",
    },
  });
  expect(invalid.status()).toBe(400);
  expect((await detail(source)).allocations[0].category_id).toBe(
    "subscriptions",
  );
  const override = await page.request.post(`/api/transactions/${source}`, {
    headers,
    data: {
      kind: "expense",
      allocations: [{ category_id: "gifts", amount: "3.00" }],
      similarPattern: "",
      similarIncludeManual: true,
    },
  });
  expect(override.ok()).toBe(true);
  expect((await override.json()).count).toBe(3);
  expect((await detail(manual)).allocations).toMatchObject([
    { category_id: "gifts", amount: 700 },
  ]);
  expect((await detail(peer)).allocations).toMatchObject([
    { category_id: "gifts", amount: 450 },
  ]);
  expect((await detail(linked)).allocations).toEqual(before[3].allocations);
});

test("receipt-not-required toggle persists, adjusts coverage and preserves classification", async ({
  page,
}) => {
  const headers = { Origin: "http://127.0.0.1:4318" };
  await page.request.post("/api/auth/login", { headers, data: { password } });
  const merchant = `No receipt ${randomUUID().slice(0, 8)}`;
  const response = await page.request.post("/api/transactions", {
    headers,
    data: {
      merchant,
      amount: "8.25",
      date: "2027-02-01",
      currency: "EUR",
      kind: "expense",
      category: "uncategorized",
      idempotencyKey: randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  const { id } = await response.json();
  await page.request.post(`/api/transactions/${id}`, {
    headers,
    data: { kind: "expense", automatic: true },
  });
  const detail = async () =>
    (await page.request.get(`/api/transactions/${id}`)).json();
  const overview = async () =>
    (await page.request.get("/api/overview?month=2027-02&currency=EUR")).json();
  const before = await detail();
  expect(before.manual).toBe(false);
  expect((await overview()).receipt_required_count).toBe(1);
  await page.goto(`/transactions/${id}`);
  await page.getByLabel("Receipt not required", { exact: true }).check();
  await expect(page.getByRole("status")).toHaveText(
    "Payment excluded from receipt coverage.",
  );
  await page.reload();
  await expect(
    page.getByLabel("Receipt not required", { exact: true }),
  ).toBeChecked();
  const after = await detail();
  expect(after.receipt_not_required).toBe(true);
  expect(after.manual).toBe(before.manual);
  expect(after.allocations).toEqual(before.allocations);
  const excluded = await overview();
  expect(excluded.receipt_required_count).toBe(0);
  expect(excluded.receipt_excluded_count).toBe(1);
  expect(excluded.spending).toBe(825);
  await page.goto("/transactions?month=2027-02&currency=EUR&receipt=missing");
  await expect(
    page.getByRole("button", { name: new RegExp(merchant) }),
  ).toHaveCount(0);
  await page.getByLabel("Filter receipt status").selectOption("not_required");
  await expect(
    page.getByRole("button", { name: new RegExp(merchant) }),
  ).toBeVisible();
  await page.goto("/?month=2027-02&currency=EUR");
  await expect(page.getByText("No receipts required")).toBeVisible();
  await page.goto(`/transactions/${id}`);
  await page.getByLabel("Receipt not required", { exact: true }).uncheck();
  await expect(page.getByRole("status")).toHaveText(
    "Payment included in receipt coverage.",
  );
  expect((await overview()).receipt_required_count).toBe(1);
  const invalid = await page.request.post(
    `/api/transactions/${id}/receipt-requirement`,
    { headers, data: { receiptNotRequired: "yes" } },
  );
  expect(invalid.status()).toBe(400);
  expect((await detail()).receipt_not_required).toBe(false);
});

test("guided period review saves, skips, imports receipts and resumes the current transaction", async ({
  page,
}) => {
  const headers = { Origin: "http://127.0.0.1:4318" };
  await page.request.post("/api/auth/login", { headers, data: { password } });
  const prefix = randomUUID().slice(0, 8);
  const create = async (
    merchant: string,
    date: string,
    category = "uncategorized",
    amount = "3.00",
    exempt = false,
  ) => {
    const response = await page.request.post("/api/transactions", {
      headers,
      data: {
        merchant,
        amount,
        date,
        currency: "EUR",
        kind: "expense",
        category,
        idempotencyKey: randomUUID(),
      },
    });
    expect(response.status()).toBe(201);
    const { id } = await response.json();
    if (exempt)
      expect(
        (
          await page.request.post(
            `/api/transactions/${id}/receipt-requirement`,
            { headers, data: { receiptNotRequired: true } },
          )
        ).ok(),
      ).toBe(true);
    return id;
  };
  const first = await create(`Review first ${prefix}`, "2027-03-01");
  const second = await create(
    `Rimi review second ${prefix}`,
    "2027-03-02",
    "groceries",
    "5.10",
  );
  const skipped = await create(
    `Review skipped ${prefix}`,
    "2027-03-03",
    "uncategorized",
    "4.00",
    true,
  );
  await create(`Review handled ${prefix}`, "2027-03-04", "gifts", "1.00", true);
  await create(`Outside review ${prefix}`, "2027-02-28");
  const queue = await page.request.get(
    "/api/review/transactions?from=2027-03-01&to=2027-03-31&currency=EUR",
  );
  expect((await queue.json()).ids).toEqual([first, second, skipped]);
  await page.goto("/review");
  await page.getByLabel("From", { exact: true }).fill("2027-03-01");
  await page.getByLabel("Through", { exact: true }).fill("2027-03-31");
  await expect(
    page.getByText("3 transactions need attention in this period."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start review", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: `Review first ${prefix}`, exact: true }),
  ).toBeVisible();
  await page.getByLabel("Category amount 1", { exact: true }).fill("2.99");
  await page
    .getByRole("button", { name: "Save and next", exact: true })
    .click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Category allocations must equal" }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(first));
  await page.getByLabel("Category amount 1", { exact: true }).fill("3.00");
  await page
    .getByLabel("Category 1", { exact: true })
    .selectOption("subscriptions");
  await page.getByLabel("Receipt not required", { exact: true }).check();
  await expect(page.getByRole("status")).toHaveText(
    "Payment excluded from receipt coverage.",
  );
  await expect(page.getByLabel("Category 1", { exact: true })).toHaveValue(
    "subscriptions",
  );
  await page
    .getByRole("button", { name: "Save and next", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: `Rimi review second ${prefix}`,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Import receipt", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Back to review", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Receipt files").setInputFiles({
    name: `review-receipt-${prefix}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from(receiptText("Rimi", `REVIEW-${prefix}`, "02.03.2027")),
  });
  await page
    .getByRole("button", { name: "Import receipts", exact: true })
    .click();
  const row = page
    .getByRole("row")
    .filter({ hasText: `review-receipt-${prefix}.txt` });
  await expect(row.getByText("Linked", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await row.getByRole("button").click();
  await page
    .getByRole("button", { name: "Back to review", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: `Rimi review second ${prefix}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".review-checks")).toContainText("Receipt linked");
  await page
    .getByRole("button", { name: "Save and next", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: `Review skipped ${prefix}`,
      exact: true,
    }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Skip for now", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Review pass complete", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Review pass complete", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Review remaining transactions", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: `Review skipped ${prefix}`,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByLabel("Category 1", { exact: true })
    .selectOption("transport");
  await page
    .getByRole("button", { name: "Save and next", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "All caught up", exact: true }),
  ).toBeVisible();
  expect(
    (
      await (
        await page.request.get(
          "/api/review/transactions?from=2027-03-01&to=2027-03-31&currency=EUR",
        )
      ).json()
    ).ids,
  ).toEqual([]);
  await page
    .getByRole("button", { name: "Choose another period", exact: true })
    .click();
  await expect(page.getByLabel("From", { exact: true })).toHaveValue(
    "2027-03-01",
  );
});

test("Amazon settings import invoice packs and the saved shortcut collects every page and document", async ({
  page,
}) => {
  await page.context().addCookies(ownerCookies);
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Amazon.de invoices" }),
  ).toBeVisible();
  await page.getByLabel("Amazon orders from").fill("2026-09-01");
  await page.getByLabel("Amazon orders through").fill("2026-09-30");
  const shortcut = page.getByRole("link", { name: "Download Amazon invoices" });
  await expect(shortcut).toHaveAttribute("href", /javascript:.*2026-09-30/);
  const href = (await shortcut.getAttribute("href"))!;
  const pack = {
    format: "expenses-amazon-invoices",
    version: 1,
    from: "2028-04-01",
    to: "2028-04-30",
    missing: [],
    invoices: [
      {
        orderId: amazonOrderId,
        filename: `amazon-${amazonOrderId}-1.pdf`,
        pdf: textPdf(
          amazonReceiptText(
            "AMAZON-BROWSER-IMPORT",
            "12.34",
            amazonOrderId,
            "02 April 2028",
          ),
        ).toString("base64"),
      },
    ],
  };
  await page.getByLabel("Amazon invoice files").setInputFiles({
    name: "test.amazon.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(pack)),
  });
  await expect(
    page.getByText(
      "1 invoices received. Receipts are being checked and matched to payments.",
    ),
  ).toBeVisible();
  await page.goto("/receipts?retailer=amazon&page=1");
  await expect(page.getByLabel("Filter retailer")).toHaveValue("amazon");
  await page
    .getByRole("button", {
      name: new RegExp(`Amazon.de.*amazon-${amazonOrderId}-1.pdf`),
    })
    .click();
  await expect(page.getByText("Huggies diapers", { exact: true })).toBeVisible({
    timeout: 30000,
  });

  const requests: string[] = [];
  const second = "305-2222222-2222222",
    third = "305-3333333-3333333";
  const outside = "305-4444444-4444444";
  const card = (order: string, date: string, invoice = true) =>
    `<div class="order-card">Order placed ${date} Order # ${order}${invoice ? `<a href="/-/en/your-orders/invoice/popover?orderId=${order}">Invoice</a>` : ""}</div>`;
  await page.route("https://www.amazon.de/**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    if (url.pathname.includes("/your-orders/orders")) {
      if (!url.searchParams.has("timeFilter"))
        return route.fulfill({ contentType: "text/html", body: "Your Orders" });
      expect(url.searchParams.get("disableCsd")).toBe("missing-library");
      return route.fulfill({
        contentType: "text/html",
        body: url.searchParams.has("page")
          ? card(second, "20 September 2026", false) +
            card(third, "25 September 2026")
          : card(amazonOrderId, "12 September 2026") +
            card(outside, "09 August 2026") +
            '<ul><li class="a-last"><a href="/-/en/your-orders/orders?timeFilter=year-2026&page=2">Next</a></li></ul>',
      });
    }
    if (url.pathname.includes("/invoice/popover")) {
      const order = url.searchParams.get("orderId");
      expect(order).not.toBe(outside);
      return route.fulfill({
        contentType: "text/html",
        body: `<a href="/gp/css/summary/print.html">Printable order summary</a><a href="https://example.com/invoice.pdf">Seller page</a><a href="/-/en/documents/download/${order}-1/invoice.pdf">Invoice 1</a>${order === amazonOrderId ? `<a href="/-/en/documents/download/${order}-2/invoice.pdf">Invoice 2</a>` : ""}`,
      });
    }
    if (url.pathname.includes("/documents/download/"))
      return route.fulfill({
        contentType: "application/pdf",
        body: textPdf(amazonReceiptText(url.pathname.split("/").at(-2)!)),
      });
    throw new Error(`Unexpected Amazon request: ${url.pathname}`);
  });
  await page.goto("https://www.amazon.de/-/en/your-orders/orders");
  // Execute the actual rendered bookmark source, including the selected dates.
  const downloaded = await page.evaluate(
    (source) =>
      window.eval(
        decodeURIComponent(source.slice("javascript:".length))
          .replace(/^void /, "")
          .replace(/\.catch\(e=>alert\(e\.message\)\)$/, ""),
      ),
    href,
  );
  expect(downloaded).toMatchObject({
    format: "expenses-amazon-invoices",
    from: "2026-09-01",
    to: "2026-09-30",
    missing: [second],
  });
  expect(
    downloaded.invoices.map((i: { orderId: string }) => i.orderId),
  ).toEqual([amazonOrderId, amazonOrderId, third]);
  expect(
    requests.filter((url) => url.includes("/documents/download/")),
  ).toHaveLength(3);
  expect(requests.some((url) => url.includes("page=2"))).toBe(true);
});

test("Amazon shortcut reports expired logins and stops on invalid invoice responses", async ({
  page,
}) => {
  await page.context().addCookies(ownerCookies);
  await page.goto("/settings");
  await page.getByLabel("Amazon orders from").fill("2026-10-01");
  await page.getByLabel("Amazon orders through").fill("2026-10-31");
  const shortcut = page.getByRole("link", { name: "Download Amazon invoices" });
  await expect(shortcut).toHaveAttribute("href", /2026-10-31/);
  const href = (await shortcut.getAttribute("href"))!;
  const source = decodeURIComponent(href.slice("javascript:".length))
    .replace(/^void /, "")
    .replace(/\.catch\(e=>alert\(e\.message\)\)$/, "");
  let mode = "login";
  await page.route("https://www.amazon.de/**", async (route) => {
    const url = new URL(route.request().url());
    if (!url.search)
      return route.fulfill({ contentType: "text/html", body: "Your Orders" });
    if (mode === "login")
      return route.fulfill({
        contentType: "text/html",
        body: '<input type="password">',
      });
    if (url.pathname.includes("/invoice/popover"))
      return route.fulfill({
        contentType: "text/html",
        body: '<a href="/-/en/documents/download/test/invoice.pdf">Invoice</a>',
      });
    if (url.pathname.includes("/documents/download/"))
      return route.fulfill({
        contentType: "text/html",
        body: "Please sign in",
      });
    return route.fulfill({
      contentType: "text/html",
      body: `<div class="order-card">02 October 2026 ${amazonOrderId}<a href="/-/en/your-orders/invoice/popover?orderId=${amazonOrderId}">Invoice</a></div>`,
    });
  });
  await page.goto("https://www.amazon.de/-/en/your-orders/orders");
  const run = async () =>
    page.evaluate(async (source) => {
      try {
        await window.eval(source);
        return "unexpected success";
      } catch (error) {
        return (error as Error).message;
      }
    }, source);
  expect(await run()).toContain("Sign in to Amazon.de");
  await expect(page.locator("#expenses-amazon-download")).toHaveCount(0);
  mode = "invalid-pdf";
  expect(await run()).toContain("missing or oversized invoice");
  await expect(page.locator("#expenses-amazon-download")).toHaveCount(0);
});

test("bulk receipt requirements update selected and similar payments without changing categories", async ({
  page,
}) => {
  const headers = { Origin: "http://127.0.0.1:4318" };
  await page.request.post("/api/auth/login", { headers, data: { password } });
  const merchant = `Receipt bulk ${randomUUID().slice(0, 8)}`;
  const create = async (
    date: string,
    description = "Monthly service",
    currency = "EUR",
    kind = "expense",
  ) => {
    const response = await page.request.post("/api/transactions", {
      headers,
      data: {
        merchant,
        date,
        description,
        currency,
        kind,
        amount: "5.10",
        category: "subscriptions",
        idempotencyKey: randomUUID(),
      },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).id as string;
  };
  const source = await create("2027-03-01");
  const peer = await create("2026-01-01");
  const other = await create("2027-03-02", "Other service");
  const foreign = await create("2027-03-03", "Monthly service", "USD");
  const income = await create("2027-03-04", "Monthly service", "EUR", "income");
  const refund = await create("2027-03-05", "Monthly service", "EUR", "refund");
  const linked = await create("2027-03-06");
  const upload = await page.request.post("/api/receipts/upload", {
    headers,
    multipart: {
      files: {
        name: "receipt-bulk.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(
          receiptText("Rimi", `receipt-bulk-${randomUUID()}`),
        ),
      },
    },
  });
  const receiptId = (await upload.json()).results[0].id;
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/receipts/${receiptId}`)).json())
          .status,
    )
    .toBe("ready");
  expect(
    (
      await page.request.post(`/api/receipts/${receiptId}/link`, {
        headers,
        data: { transactionId: linked, amount: "5.10" },
      })
    ).ok(),
  ).toBe(true);
  const ids = [source, peer, other, foreign, income, refund, linked];
  const detail = async (id: string) =>
    (await page.request.get(`/api/transactions/${id}`)).json();
  const before = await Promise.all(ids.map(detail));
  await page.goto(`/transactions/${source}`);
  await page.getByLabel("Personal note").fill("Unsaved category note");
  await page
    .getByLabel("Update receipt requirement for similar transactions")
    .check();
  await expect(
    page.getByText("1 other matching transactions will change."),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Mark 2 transactions receipt not required",
      exact: true,
    })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "2 transactions marked receipt not required.",
  );
  await expect(page.getByLabel("Personal note")).toHaveValue(
    "Unsaved category note",
  );
  for (const [index, id] of ids.entries()) {
    const after = await detail(id);
    expect(after.receipt_not_required).toBe([source, peer].includes(id));
    expect(after.allocations).toEqual(before[index].allocations);
    expect(after.manual).toBe(before[index].manual);
    expect(after.note).toBe(before[index].note);
    expect(after.receipts).toEqual(before[index].receipts);
  }
  const invalid = await page.request.post(
    "/api/transactions/receipt-requirement",
    {
      headers,
      data: { ids: [source, randomUUID()], receiptNotRequired: false },
    },
  );
  expect(invalid.status()).toBe(404);
  expect((await detail(source)).receipt_not_required).toBe(true);
  const invalidKind = await page.request.post(
    "/api/transactions/receipt-requirement",
    { headers, data: { ids: [source, income], receiptNotRequired: false } },
  );
  expect(invalidKind.status()).toBe(400);
  expect((await detail(source)).receipt_not_required).toBe(true);
  await page.goto(
    `/transactions?history=true&currency=EUR&search=${encodeURIComponent(merchant)}`,
  );
  await page.getByLabel("Select all payments on this page").check();
  // Income is never selectable; explicit selection can update receipt-linked payments.
  await expect(page.getByText("5 selected", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Mark receipt not required", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "3 transactions marked receipt not required.",
  );
  await page.getByLabel("Select all payments on this page").check();
  await page
    .getByRole("button", { name: "Require receipts", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "5 transactions marked receipt required.",
  );
  for (const id of ids)
    expect((await detail(id)).receipt_not_required).toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Select all payments on this page").check();
  await expect(page.getByText("5 selected", { exact: true })).toBeVisible();
  const invalidValue = await page.request.post(
    "/api/transactions/receipt-requirement",
    { headers, data: { ids: [source], receiptNotRequired: "yes" } },
  );
  expect(invalidValue.status()).toBe(400);
});

test("account nicknames persist and appear in filters, lists and transaction details", async ({
  page,
}) => {
  await page.context().addCookies(ownerCookies);
  const headers = { Origin: "http://127.0.0.1:4318" };
  const today = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Tallinn",
  }).format(new Date());
  const created = await page.request.post("/api/transactions", {
    headers,
    data: {
      merchant: "Nickname test purchase",
      date: today,
      amount: "7.50",
      currency: "CHF",
      category: "groceries",
      idempotencyKey: randomUUID(),
    },
  });
  expect(created.ok()).toBe(true);
  const entry = await created.json();
  const state = await (await page.request.get("/api/state")).json();
  const account = state.accounts.find(
    (a: { source: string; currency: string }) =>
      a.source === "cash" && a.currency === "CHF",
  );
  expect(account.nickname).toBeNull();
  await page.goto("/connections");
  const card = page.locator(".account-card").filter({
    has: page.getByRole("heading", { name: account.name, exact: true }),
  });
  await card.getByLabel("Nickname", { exact: true }).fill("  Travel wallet  ");
  await card.getByRole("button", { name: "Save nickname" }).click();
  await expect(page.getByRole("status")).toHaveText("Account nickname saved.");
  await expect(
    page.getByRole("heading", { name: "Travel wallet", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Travel wallet", exact: true }),
  ).toBeVisible();
  await page.goto(
    `/transactions?account=${account.id}&currency=CHF&search=Nickname%20test%20purchase`,
  );
  await expect(
    page.getByLabel("Filter account").locator("option:checked"),
  ).toHaveText("Travel wallet · CHF");
  await expect(
    page.getByRole("cell", { name: "Travel wallet", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Nickname test purchase/ }).click();
  await expect(page.getByText("Travel wallet", { exact: true })).toBeVisible();
  const detail = await (
    await page.request.get(`/api/transactions/${entry.id}`)
  ).json();
  expect(detail.account_name).toBe("Travel wallet");
  for (const nickname of ["x".repeat(101), 123]) {
    const invalid = await page.request.post(`/api/accounts/${account.id}`, {
      headers,
      data: { nickname },
    });
    expect(invalid.status()).toBe(400);
  }
  const missing = await page.request.post(`/api/accounts/${randomUUID()}`, {
    headers,
    data: { nickname: "Missing" },
  });
  expect(missing.status()).toBe(404);
  await page.goto("/connections");
  const renamed = page.locator(".account-card").filter({
    has: page.getByRole("heading", { name: "Travel wallet", exact: true }),
  });
  await renamed.getByLabel("Nickname", { exact: true }).fill("");
  await renamed.getByRole("button", { name: "Save nickname" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Account nickname removed.",
  );
  await expect(
    page.getByRole("heading", { name: account.name, exact: true }),
  ).toBeVisible();
  expect(
    (await (await page.request.get(`/api/transactions/${entry.id}`)).json())
      .account_name,
  ).toBe(account.name);
});

test("overview supports one to twelve months, cumulative net cash flow and signed refunds", async ({
  page,
}) => {
  const password = "only-for-isolated-test-db";
  const headers = { Origin: "http://127.0.0.1:4318" };
  const status = await signInOwner(page);
  const create = async (
    date: string,
    merchant: string,
    amount: string,
    category: string,
    kind = "expense",
    currency = "JPY",
  ) => {
    const response = await page.request.post("/api/transactions", {
      headers,
      data: {
        date,
        merchant,
        amount,
        category,
        kind: ["investment", "pension"].includes(kind) ? "expense" : kind,
        currency,
        idempotencyKey: randomUUID(),
      },
    });
    expect(response.ok()).toBe(true);
    if (["investment", "pension"].includes(kind)) {
      const entry = await response.json();
      const updated = await page.request.post(`/api/transactions/${entry.id}`, {
        headers,
        data: { kind },
      });
      expect(updated.ok()).toBe(true);
    }
  };
  await create("2033-12-31", "Outside start", "999", "groceries");
  await create("2034-01-01", "Analysis market", "600", "groceries");
  await create("2034-02-15", "Analysis cafe", "200", "restaurants");
  await create("2034-03-15", "Analysis market", "800", "groceries", "refund");
  await create(
    "2034-06-30",
    "Analysis salary",
    "2000",
    "uncategorized",
    "income",
  );
  await create(
    "2034-01-15",
    "January income",
    "100",
    "uncategorized",
    "income",
  );
  await create("2034-03-15", "March income", "300", "uncategorized", "income");
  await create("2034-07-01", "Outside end", "999", "groceries");
  await create(
    "2034-01-01",
    "Other currency",
    "99",
    "groceries",
    "expense",
    "USD",
  );
  await create(
    "2033-12-31",
    "Earlier investment",
    "900",
    "uncategorized",
    "investment",
  );
  await create(
    "2034-01-01",
    "Period investment",
    "300",
    "uncategorized",
    "investment",
  );
  await create(
    "2034-06-30",
    "Period pension",
    "150",
    "uncategorized",
    "pension",
  );
  await create(
    "2034-07-01",
    "Later investment",
    "700",
    "uncategorized",
    "investment",
  );
  await create(
    "2034-02-01",
    "Other currency investment",
    "50",
    "uncategorized",
    "investment",
    "USD",
  );
  const reportResponse = await page.request.get(
    "/api/spending-analysis?month=2034-06&currency=JPY",
  );
  expect(reportResponse.ok()).toBe(true);
  const report = await reportResponse.json();
  expect(report.months.map((point: { month: string }) => point.month)).toEqual([
    "2034-01",
    "2034-02",
    "2034-03",
    "2034-04",
    "2034-05",
    "2034-06",
  ]);
  expect(
    report.months.map((point: { spending: number }) => point.spending),
  ).toEqual([600, 200, -800, 0, 0, 0]);
  expect(report.months[5].income).toBe(2000);
  expect(report.investment.contributed).toBe(300);
  expect(report.investment.history_contributed).toBe(1200);
  expect(report.pension.contributed).toBe(150);
  expect(report.months[0].investment).toBe(300);
  expect(report.months[5].pension).toBe(150);
  expect(
    report.categories.reduce(
      (sum: number, row: { amount: number }) => sum + row.amount,
      0,
    ),
  ).toBe(0);
  expect(
    report.merchants.every(
      (row: { merchant: string }) =>
        ![
          "Outside start",
          "Outside end",
          "Other currency",
          "Analysis salary",
        ].includes(row.merchant),
    ),
  ).toBe(true);
  expect(
    (
      await page.request.get(
        "/api/spending-analysis?month=2034-13&currency=JPY",
      )
    ).status(),
  ).toBe(400);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?month=2034-06&currency=JPY");
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("nav").getByRole("button", { name: "Overview", exact: true }),
  ).toHaveCount(1);
  await expect(
    page
      .locator("nav")
      .getByRole("button", { name: "6 month view", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Period length")).toHaveValue("1");
  await expect(page.locator(".contributions-panel tbody tr")).toHaveCount(1);
  await page.getByLabel("Period length").selectOption("6");
  await expect(page).toHaveURL(/months=6/);
  await expect(
    page.getByRole("heading", { name: "Spending and income" }),
  ).toBeVisible();
  await expect(page.getByLabel("Period ending", { exact: true })).toHaveValue(
    "2034-06",
  );
  const contributions = page.locator(".contributions-panel");
  await expect(contributions.locator("tbody tr")).toHaveCount(6);
  await expect(contributions.locator(".metric-value").nth(0)).toHaveText(
    "JP¥300",
  );
  await expect(contributions.locator(".metric-value").nth(1)).toHaveText(
    "JP¥150",
  );
  await contributions
    .getByRole("button", { name: "View transfers" })
    .first()
    .click();
  await expect(page).toHaveURL(/from=2034-01-01&to=2034-06-30/);
  await expect(
    page.getByRole("button", { name: /Period investment/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /Earlier investment|Later investment|Other currency investment/,
    }),
  ).toHaveCount(0);
  await page.goto("/six-month?month=2034-06&currency=JPY");
  await expect(
    page.getByLabel("Cumulative net cash flow line", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: /Explore June 2034: spending.*cumulative net cash flow JP¥1,950/,
    })
    .focus();
  await expect(page.locator(".analysis-chart-detail").first()).toContainText(
    "Cumulative net cash flow JP¥1,950",
  );
  await page
    .getByRole("button", { name: /Explore January 2034: spending/ })
    .click();
  await expect(page.getByLabel("Breakdown period")).toHaveValue("2034-01");
  await page.getByLabel("Analysis category").selectOption("groceries");
  const merchant = page
    .locator(".analysis-merchant")
    .filter({ hasText: "Analysis market" });
  await merchant.click();
  await expect(page.locator(".analysis-merchant-detail")).toContainText(
    "January 2034",
  );
  await expect(page.locator(".analysis-merchant-detail")).toContainText(
    "Groceries",
  );
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(page.getByLabel("Breakdown period")).toHaveValue("");
  await expect(page.getByLabel("Analysis category")).toHaveValue("");
  await page
    .getByRole("button", { name: /Explore March 2034: spending/ })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Breakdown period")).toHaveValue("2034-03");
  await expect(page.locator(".analysis-category-list")).toContainText(
    "Net refunds",
  );
  await expect(page.locator(".analysis-chart-detail").first()).toContainText(
    "-JP¥800",
  );
  await expect(page.locator(".analysis-chart-detail").first()).toContainText(
    "Cumulative net cash flow JP¥100",
  );
  await page.getByRole("button", { name: "Income", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Income", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page
    .getByRole("button", { name: "Cumulative net cash flow", exact: true })
    .click();
  await expect(
    page.getByLabel("Cumulative net cash flow line", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Spending", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Spending", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Next month" }).click();
  await expect(page.getByLabel("Period ending", { exact: true })).toHaveValue(
    "2034-07",
  );
  await expect(page.getByLabel("Breakdown period")).toHaveValue("");
  await page.reload();
  await expect(page.getByLabel("Period ending", { exact: true })).toHaveValue(
    "2034-07",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "Where the money goes" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByLabel("Analysis category").selectOption("restaurants");
  await expect(page.locator(".analysis-merchant")).toContainText(
    "Analysis cafe",
  );
  await page.getByLabel("Period length").selectOption("12");
  await expect(page.locator(".contributions-panel tbody tr")).toHaveCount(12);
  await expect(page.getByLabel("Period length")).toHaveValue("12");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  await expect(page.getByLabel("Period length")).toHaveValue("12");
  const yearly = await (
    await page.request.get(
      "/api/spending-analysis?month=2034-06&currency=JPY&months=12",
    )
  ).json();
  expect(yearly.from).toBe("2033-07-01");
  expect(yearly.to).toBe("2034-07-01");
  expect(yearly.months).toHaveLength(12);
  expect(yearly.investment.contributed).toBe(1200);
  const single = await (
    await page.request.get("/api/overview?month=2034-06&currency=JPY&months=1")
  ).json();
  expect(single.from).toBe("2034-06-01");
  expect(single.net_cash_flow).toBe(1850);
  const six = await (
    await page.request.get("/api/overview?month=2034-06&currency=JPY&months=6")
  ).json();
  expect(six.net_cash_flow).toBe(1950);
  expect(six.receipt_required_count).toBe(3);
  for (const months of ["0", "13", "1.5", "invalid"])
    expect(
      (
        await page.request.get(
          `/api/spending-analysis?month=2034-06&months=${months}`,
        )
      ).status(),
    ).toBe(400);
  await page.getByLabel("Period length").selectOption("1");
  await expect(page.locator(".contributions-panel tbody tr")).toHaveCount(1);
  await expect(page.getByLabel("Analysis category")).toHaveValue("");
  expect(errors).toEqual([]);
});

test("uncategorized receipt rows offer popular categories and save only the chosen item", async ({
  page,
}) => {
  const headers = { Origin: "http://127.0.0.1:4318" };
  const status = await signInOwner(page);
  await page.goto("/receipts");
  await page.getByLabel("Receipt files").setInputFiles({
    name: "quick-categories.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(receiptText("Rimi", "QUICK-CATEGORIES")),
  });
  await page.getByRole("button", { name: "Import receipts" }).click();
  await page
    .getByRole("button", { name: /Rimi.*quick-categories.txt/ })
    .click();
  await expect(page.getByText("Pesuvahend", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  const receiptId = new URL(page.url()).pathname.split("/").at(-1)!;
  const getReceipt = async () =>
    (await page.request.get(`/api/receipts/${receiptId}`)).json();
  const receipt = await getReceipt();
  const items = receipt.items.map(
    (item: { amount: number }, index: number) => ({
      ...item,
      amount: (item.amount / 100).toFixed(2),
      category_id: index < 2 ? "uncategorized" : "health",
    }),
  );
  for (const [index, category] of [
    "health",
    "health",
    "clothing",
    "clothing",
    "household",
  ].entries()) {
    items.push({
      description: `Popularity sample ${index}`,
      amount: "0.00",
      category_id: category,
      quantity: null,
      unit: null,
    });
  }
  const updated = await page.request.post(`/api/receipts/${receiptId}`, {
    headers,
    data: { ...receipt, total: "5.10", items },
  });
  expect(updated.ok()).toBe(true);
  if (status.needsSetup)
    expect(
      (await getReceipt()).suggested_categories.map(
        (category: { id: string }) => category.id,
      ),
    ).toEqual(["groceries", "health", "clothing", "household"]);
  expect(
    (
      await page.request.post(`/api/receipts/${receiptId}/cash`, { headers })
    ).ok(),
  ).toBe(true);
  await page.reload();
  const firstChoices = page.getByRole("group", {
    name: "Quick categories for product 1",
    exact: true,
  });
  await expect(firstChoices.getByRole("button")).toHaveCount(4);
  await expect(
    page.getByRole("group", {
      name: "Quick categories for product 3",
      exact: true,
    }),
  ).toHaveCount(0);
  await mkdir(".data/screenshots", { recursive: true });
  await page.screenshot({
    path: ".data/screenshots/receipt-quick-categories-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    await page.locator(".product-table").evaluate((table) => {
      const container = table.parentElement!;
      return container.scrollWidth <= container.clientWidth;
    }),
  ).toBe(true);
  await page.screenshot({
    path: ".data/screenshots/receipt-quick-categories-phone.png",
    fullPage: true,
  });
  await firstChoices
    .getByRole("button", { name: "Groceries", exact: true })
    .click();
  await expect(firstChoices).toHaveCount(0);
  const saved = await getReceipt();
  expect(saved.items[0].category_id).toBe("groceries");
  expect(saved.items[0].manual).toBe(true);
  expect(saved.items[1].category_id).toBe("uncategorized");
  expect(saved.items.map((item: { amount: number }) => item.amount)).toEqual(
    receipt.items
      .map((item: { amount: number }) => item.amount)
      .concat([0, 0, 0, 0, 0]),
  );
  const payment = await (
    await page.request.get(`/api/transactions/${saved.links[0].transaction_id}`)
  ).json();
  expect(
    payment.allocations.find(
      (row: { category_id: string }) => row.category_id === "groceries",
    ).amount,
  ).toBe(200);
  expect(
    payment.allocations.find(
      (row: { category_id: string }) => row.category_id === "uncategorized",
    ).amount,
  ).toBe(300);
  expect(
    (
      await page.request.post(`/api/receipts/${receiptId}/item-category`, {
        headers,
        data: { itemId: randomUUID(), categoryId: "groceries" },
      })
    ).status(),
  ).toBe(404);
  await page.getByRole("button", { name: "Edit receipt", exact: true }).click();
  await page
    .getByRole("group", { name: "Quick categories for product 2", exact: true })
    .getByRole("button", { name: "Groceries", exact: true })
    .click();
  await expect(
    page.getByLabel("Product category 2", { exact: true }),
  ).toHaveValue("groceries");
  expect((await getReceipt()).items[1].category_id).toBe("uncategorized");
  await page.getByRole("button", { name: "Save and validate" }).click();
  await expect(
    page.getByRole("button", { name: "Edit receipt", exact: true }),
  ).toBeVisible();
  expect((await getReceipt()).items[1].category_id).toBe("groceries");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("invalid receipts can be deleted with confirmation while linked payments remain", async ({
  page,
}) => {
  const headers = { Origin: "http://127.0.0.1:4318" };
  await signInOwner(page);
  const upload = async (invalid: boolean) => {
    const text = receiptText("Rimi", `DELETE-${randomUUID()}`, "01.04.2026");
    const response = await page.request.post("/api/receipts/upload", {
      headers,
      multipart: {
        files: {
          name: "delete-receipt.txt",
          mimeType: "text/plain",
          buffer: Buffer.from(
            invalid ? text.replace("Kokku 5,10", "Kokku 5,99") : text,
          ),
        },
      },
    });
    expect(response.ok()).toBe(true);
    const id = (await response.json()).results[0].id;
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/receipts/${id}`)).json()).status,
        { timeout: 30000 },
      )
      .toBe(invalid ? "review" : "ready");
    return id;
  };
  const invalidId = await upload(true);
  const returnTo = "/receipts?retailer=rimi&page=1";
  await page.goto(
    `/receipts/${invalidId}?returnTo=${encodeURIComponent(returnTo)}`,
  );
  const button = page.getByRole("button", {
    name: "Delete receipt",
    exact: true,
  });
  await expect(button).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await button.click();
  expect((await page.request.get(`/api/receipts/${invalidId}`)).ok()).toBe(
    true,
  );
  page.once("dialog", (dialog) => dialog.accept());
  await button.click();
  await expect(page).toHaveURL(`http://127.0.0.1:4318${returnTo}`);
  expect((await page.request.get(`/api/receipts/${invalidId}`)).status()).toBe(
    404,
  );
  expect(
    (await page.request.get(`/api/receipts/${invalidId}/file`)).status(),
  ).toBe(404);
  const linkedId = await upload(false);
  expect(
    (
      await page.request.post(`/api/receipts/${linkedId}/cash`, { headers })
    ).ok(),
  ).toBe(true);
  const linked = await (
    await page.request.get(`/api/receipts/${linkedId}`)
  ).json();
  const paymentId = linked.links[0].transaction_id;
  const paymentBefore = await (
    await page.request.get(`/api/transactions/${paymentId}`)
  ).json();
  expect(
    (await page.request.delete(`/api/receipts/${linkedId}`, { headers })).ok(),
  ).toBe(true);
  const payment = await page.request.get(`/api/transactions/${paymentId}`);
  expect(payment.ok()).toBe(true);
  expect((await payment.json()).amount).toBe(paymentBefore.amount);
  expect(
    (
      await page.request.delete(`/api/receipts/${linkedId}`, { headers })
    ).status(),
  ).toBe(404);
});

test("settings control the inclusive import start date and remove older records", async ({
  page,
}) => {
  const headers = { Origin: "http://127.0.0.1:4318" };
  await signInOwner(page);
  expect(
    (
      await page.request.post("/api/settings/import-window", {
        headers,
        data: { startDate: "2025-01-01" },
      })
    ).ok(),
  ).toBe(true);
  const createPayment = (date: string) =>
    page.request.post("/api/transactions", {
      headers,
      data: {
        merchant: "Import cutoff test",
        amount: "2.00",
        currency: "EUR",
        date,
        category: "groceries",
        idempotencyKey: randomUUID(),
      },
    });
  const older = await (await createPayment("2025-12-31")).json();
  const boundary = await (await createPayment("2026-01-01")).json();
  await page.goto("/receipts");
  await page.getByLabel("Receipt files").setInputFiles({
    name: "cutoff-old.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(receiptText("Rimi", "E2E-CUTOFF", "31.12.2025")),
  });
  await page.getByRole("button", { name: "Import receipts" }).click();
  await page.getByRole("button", { name: /Rimi.*cutoff-old.txt/ }).click();
  await expect(page.getByText("Pesuvahend", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  const receiptId = new URL(page.url()).pathname.split("/").at(-1)!;
  await page.goto("/settings");
  await expect(
    page.getByLabel("Import start date", { exact: true }),
  ).toHaveValue("2025-01-01");
  await page
    .getByLabel("Import start date", { exact: true })
    .fill("2026-01-01");
  await page
    .getByRole("button", { name: "Save start date", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Import start date saved.",
  );
  expect(
    (await (await page.request.get("/api/settings")).json()).importStartDate,
  ).toBe("2026-01-01");
  expect(
    (await page.request.get(`/api/transactions/${older.id}`)).status(),
  ).toBe(404);
  expect(
    (await page.request.get(`/api/transactions/${boundary.id}`)).ok(),
  ).toBe(true);
  expect((await page.request.get(`/api/receipts/${receiptId}`)).status()).toBe(
    404,
  );
  expect((await createPayment("2025-12-31")).status()).toBe(400);
  const uploaded = await page.request.post("/api/receipts/upload", {
    headers,
    multipart: {
      files: {
        name: "cutoff-repeat.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(receiptText("Rimi", "E2E-CUTOFF", "31.12.2025")),
      },
    },
  });
  expect(uploaded.ok()).toBe(true);
  const result = await uploaded.json();
  await expect
    .poll(
      async () =>
        (
          await page.request.get(`/api/receipts/${result.results[0].id}`)
        ).status(),
      { timeout: 30000 },
    )
    .toBe(404);
  expect(
    (
      await page.request.post("/api/settings/import-window", {
        headers,
        data: { startDate: "2026-02-30" },
      })
    ).status(),
  ).toBe(400);
  expect(
    (await (await page.request.get("/api/settings")).json()).importStartDate,
  ).toBe("2026-01-01");
});

test("merchant groups can be created, edited and undone in Settings", async ({
  page,
}) => {
  await page.context().addCookies(ownerCookies);
  const headers = { Origin: "http://127.0.0.1:4318" };
  for (const merchant of ["Alias Branch One", "Alias Branch Two"]) {
    const response = await page.request.post("/api/transactions", {
      headers,
      data: {
        merchant,
        amount: "2.00",
        currency: "EUR",
        date: "2026-10-05",
        category: "groceries",
        kind: "expense",
        idempotencyKey: randomUUID(),
      },
    });
    expect(response.ok()).toBe(true);
  }
  await page.goto("/settings");
  await expect(
    page.getByRole("button", { name: "Edit Wolt", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit Selver", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Group merchants", exact: true })
    .click();
  await page.getByLabel("Display name", { exact: true }).fill("Alias Company");
  await page.getByLabel("Find imported names").fill("Alias Branch");
  await page.getByLabel("Alias Branch One", { exact: true }).check();
  await page.getByLabel("Alias Branch Two", { exact: true }).check();
  await page.getByRole("button", { name: "Save group", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Edit Alias Company", exact: true }),
  ).toBeVisible();
  let search = await (
    await page.request.get(
      "/api/transactions?history=true&search=Alias%20Company",
    )
  ).json();
  expect(search.count).toBe(2);
  expect(
    search.rows.every(
      (row: { merchant_group: string }) =>
        row.merchant_group === "Alias Company",
    ),
  ).toBe(true);
  const detail = await (
    await page.request.get(`/api/transactions/${search.rows[0].id}`)
  ).json();
  expect(detail.merchant).toMatch(/^Alias Branch /);
  await page
    .getByRole("button", { name: "Edit Alias Company", exact: true })
    .click();
  await page
    .getByLabel("Display name", { exact: true })
    .fill("Renamed Alias Company");
  await page.getByRole("button", { name: "Save group", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Edit Renamed Alias Company",
      exact: true,
    }),
  ).toBeVisible();
  const conflict = await page.request.post("/api/merchants", {
    headers,
    data: { name: "Another group", aliases: ["ALIAS BRANCH ONE"] },
  });
  expect(conflict.status()).toBe(409);
  await page
    .getByRole("button", { name: "Ungroup Renamed Alias Company", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Edit Renamed Alias Company",
      exact: true,
    }),
  ).toHaveCount(0);
  search = await (
    await page.request.get(
      "/api/transactions?history=true&search=Renamed%20Alias%20Company",
    )
  ).json();
  expect(search.count).toBe(0);
  search = await (
    await page.request.get(
      "/api/transactions?history=true&search=Alias%20Branch",
    )
  ).json();
  expect(search.count).toBe(2);
});

test("mobile navigation, compact filters and sheets keep phone workflows usable", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const headers = { Origin: "http://127.0.0.1:4318" };
  const status = await signInOwner(page);
  const prefix = `Mobile purchase ${randomUUID().slice(0, 8)}`;
  const date = "2040-01-15";
  for (const [suffix, category] of [
    ["A long merchant name for testing narrow phone screens", "groceries"],
    ["Subscription", "subscriptions"],
  ]) {
    const created = await page.request.post("/api/transactions", {
      headers,
      data: {
        merchant: `${prefix} ${suffix}`,
        amount: "12.34",
        currency: "EUR",
        date,
        category,
        kind: "expense",
        idempotencyKey: randomUUID(),
      },
    });
    expect(created.ok()).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `/transactions?month=2040-01&currency=EUR&search=${encodeURIComponent(prefix)}`,
  );
  const navigation = page.getByRole("navigation", {
    name: "Mobile navigation",
    exact: true,
  });
  await expect(navigation).toBeVisible();
  await expect(
    navigation.getByRole("button", { name: "Transactions", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".entry-table tbody tr")).toHaveCount(2);
  await expect(page.getByLabel("Filter category")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Require receipts", exact: true }),
  ).toBeHidden();
  expect(
    await page
      .locator(".entry-table tbody tr")
      .first()
      .evaluate((row) => row.getBoundingClientRect().top),
  ).toBeLessThan(500);
  expect(
    await page
      .getByLabel("Search transactions")
      .evaluate((input) => getComputedStyle(input).fontSize),
  ).toBe("16px");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Filters", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await page.getByLabel("Filter category").selectOption("groceries");
  await page.getByRole("button", { name: "Show results", exact: true }).click();
  await expect(page.getByLabel("Filter category")).toBeHidden();
  await expect(page.locator(".entry-table tbody tr")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Remove category filter" }),
  ).toBeVisible();
  const listUrl = page.url();
  await page.locator(".entry-table .merchant-link").first().click();
  await expect(
    page.getByRole("heading", { name: "Transaction details" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "All transactions", exact: true })
    .click();
  await expect(page).toHaveURL(listUrl);
  await expect(
    page.getByRole("button", { name: "Remove category filter" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Remove category filter" }).click();
  await expect(page.locator(".entry-table tbody tr")).toHaveCount(2);
  const selection = page.locator(".entry-table input[type=checkbox]").first();
  await selection.check();
  await expect(
    page.getByRole("button", { name: "Require receipts", exact: true }),
  ).toBeVisible();
  await selection.uncheck();
  await expect(
    page.getByRole("button", { name: "Require receipts", exact: true }),
  ).toBeHidden();
  await navigation.getByRole("button", { name: "More", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation", exact: true });
  await expect(drawer).toBeVisible();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe(
    "hidden",
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Close menu", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(
    navigation.getByRole("button", { name: "More", exact: true }),
  ).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
  await page.getByRole("button", { name: "Cash entry", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Record a cash entry",
    exact: true,
  });
  await expect(dialog.getByLabel("Merchant or description")).toBeFocused();
  expect(
    await dialog.evaluate((element) =>
      Math.round(element.getBoundingClientRect().bottom),
    ),
  ).toBe(844);
  await dialog
    .getByRole("button", { name: "Record entry", exact: true })
    .focus();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Close cash entry", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Cash entry", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Cash entry", exact: true }).click();
  await dialog
    .getByLabel("Merchant or description")
    .fill(`${prefix} Cash entry`);
  await dialog.getByLabel("Amount", { exact: true }).fill("4.50");
  await dialog.getByLabel("Date", { exact: true }).fill(date);
  await dialog
    .getByRole("button", { name: "Record entry", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".entry-table tbody tr")).toHaveCount(3);
  await mkdir(".data/screenshots", { recursive: true });
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const amounts = await page
      .locator(".entry-amount")
      .evaluateAll((elements) =>
        elements.map((element) => ({
          left: element.getBoundingClientRect().left,
          right: element.getBoundingClientRect().right,
        })),
      );
    expect(amounts.every((rect) => rect.left >= 0 && rect.right <= width)).toBe(
      true,
    );
    if (width === 390)
      await page.screenshot({
        path: ".data/screenshots/mobile-transactions.png",
      });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Cash entry", exact: true }).click();
  await page.screenshot({ path: ".data/screenshots/mobile-cash-entry.png" });
  await page.keyboard.press("Escape");
  await navigation
    .getByRole("button", { name: "Receipts", exact: true })
    .click();
  await page.getByLabel("Receipt files").setInputFiles({
    name: `${prefix}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from(receiptText("Rimi", prefix, "15.01.2040")),
  });
  await page
    .getByRole("button", { name: "Import receipts", exact: true })
    .click();
  const receipt = page
    .locator(".receipt-table tbody tr")
    .filter({ hasText: prefix });
  await expect(receipt).toBeVisible({ timeout: 30000 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: ".data/screenshots/mobile-receipts.png" });
  await receipt.getByRole("button").click();
  await expect(page.locator(".product-table tbody tr")).toHaveCount(3, {
    timeout: 30000,
  });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await page
        .locator(".product-table")
        .evaluate(
          (table) =>
            table.parentElement!.scrollWidth <=
            table.parentElement!.clientWidth,
        ),
    ).toBe(true);
  }
  await page.screenshot({
    path: ".data/screenshots/mobile-receipt-details.png",
    fullPage: true,
  });
  await navigation.getByRole("button", { name: "More", exact: true }).click();
  await drawer.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Merchants", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await navigation
    .getByRole("button", { name: "Overview", exact: true })
    .click();
  await expect(page.locator(".metric-grid")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: ".data/screenshots/mobile-overview.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    `/transactions?month=2040-01&currency=EUR&search=${encodeURIComponent(prefix)}`,
  );
  await expect(navigation).toBeHidden();
  await expect(page.getByLabel("Filter category")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Filters", exact: true }),
  ).toBeHidden();
  await page.screenshot({ path: ".data/screenshots/desktop-transactions.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await navigation.getByRole("button", { name: "More", exact: true }).click();
  await drawer.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
  expect(errors).toEqual([]);
});

test("double-entry journals and opening balances remain balanced through the UI", async ({
  page,
}) => {
  await signInOwner(page);
  const response = await page.request.post("/api/transactions", {
    headers: { Origin: "http://127.0.0.1:4318" },
    data: {
      merchant: "Accounting regression purchase",
      date: "2026-01-02",
      amount: "25.00",
      currency: "EUR",
      category: "groceries",
      idempotencyKey: randomUUID(),
    },
  });
  expect(response.ok()).toBe(true);
  const entry = await response.json();
  const before = await (
    await page.request.get("/api/accounting/trial-balance?currency=EUR")
  ).json();
  const cash = before.accounts.find(
    (account: { code: string }) => account.code === "cash:EUR",
  );
  expect(before.debit).toBe(before.credit);
  try {
    await page.goto(`/transactions/${entry.id}`);
    await page.getByText("Journal postings", { exact: true }).click();
    const journal = page.locator("details").filter({
      has: page.locator("summary", { hasText: "Journal postings" }),
    });
    await expect(
      journal.getByRole("columnheader", { name: "Debit", exact: true }),
    ).toBeVisible();
    await expect(
      journal.getByRole("row").filter({ hasText: "Groceries" }),
    ).toContainText("€25.00");
    await expect(
      journal.getByRole("row").filter({ hasText: "Cash" }),
    ).toContainText("€25.00");
    await page.goto("/advanced/accounts");
    const panel = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Accounting", exact: true }),
    });
    const row = panel
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: "Cash", exact: true }) });
    await row.getByRole("button", { name: "Edit opening balance" }).click();
    await panel
      .getByLabel("Opening balance (EUR)", { exact: true })
      .fill("100.00");
    await panel.getByLabel("Date", { exact: true }).fill("2026-01-01");
    await panel.getByRole("button", { name: "Save opening balance" }).click();
    await expect(page.getByRole("status")).toHaveText("Opening balance saved.");
    await expect(
      panel.getByRole("row").filter({
        has: page.getByRole("cell", {
          name: "Opening balances",
          exact: true,
        }),
      }),
    ).toContainText("€100.00 Cr");
    const after = await (
      await page.request.get("/api/accounting/trial-balance?currency=EUR")
    ).json();
    expect(
      after.accounts.find((account: { id: string }) => account.id === cash.id)
        .balance,
    ).toBe(cash.balance - cash.opening_balance + 10000);
    expect(after.debit).toBe(after.credit);
    const invalid = await page.request.post("/api/accounting/opening-balance", {
      headers: { Origin: "http://127.0.0.1:4318" },
      data: { accountId: cash.id, amount: "10.00", date: "2099-01-01" },
    });
    expect(invalid.status()).toBe(400);
  } finally {
    await page.request.post("/api/accounting/opening-balance", {
      headers: { Origin: "http://127.0.0.1:4318" },
      data: {
        accountId: cash.id,
        amount: decimalMoney(cash.opening_balance, "EUR"),
        date: cash.opening_date || "2026-01-01",
      },
    });
    await page.request.delete(`/api/transactions/${entry.id}`, {
      headers: { Origin: "http://127.0.0.1:4318" },
    });
  }
});

test("advanced bookkeeping creates accounts, posts and edits split journals, and exposes ledger reports", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signInOwner(page);
  await page.goto("/");
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Advanced", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Advanced bookkeeping", exact: true }),
  ).toBeVisible();
  const menu = page.getByRole("navigation", {
    name: "Advanced bookkeeping",
    exact: true,
  });
  await menu.getByRole("button", { name: "Accounts", exact: true }).click();
  for (const [code, name, type] of [
    ["1101", "Advanced wallet", "asset"],
    ["3101", "Advanced owner equity", "equity"],
    ["6101", "Advanced fee", "expense"],
  ]) {
    await page
      .getByRole("button", { name: "New account", exact: true })
      .click();
    await page.getByLabel("Account code", { exact: true }).fill(code);
    await page.getByLabel("Account name", { exact: true }).fill(name);
    await page
      .getByRole("combobox", { name: "Account type", exact: true })
      .selectOption(type);
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }
  const accounts = (
    await (
      await page.request.get("/api/accounting/trial-balance?currency=EUR")
    ).json()
  ).accounts;
  const wallet = accounts.find(
    (a: { display_code: string }) => a.display_code === "1101",
  );
  const equity = accounts.find(
    (a: { display_code: string }) => a.display_code === "3101",
  );
  const fee = accounts.find(
    (a: { display_code: string }) => a.display_code === "6101",
  );
  expect(
    (
      await page.request.post("/api/accounting/accounts", {
        headers: { Origin: "http://127.0.0.1:4318" },
        data: {
          code: "1101",
          name: "Advanced USD wallet",
          type: "asset",
          currency: "USD",
        },
      })
    ).status(),
  ).toBe(201);
  await menu.getByRole("button", { name: "Journal", exact: true }).click();
  await page
    .getByRole("button", { name: "New journal entry", exact: true })
    .click();
  await page.getByLabel("Date", { exact: true }).fill("2026-01-15");
  await page
    .getByLabel("Description", { exact: true })
    .fill("Advanced funding");
  await page.getByLabel("Reference", { exact: true }).fill("ADV-1");
  await page
    .getByRole("combobox", { name: "Account 1", exact: true })
    .selectOption(wallet.id);
  await page.getByLabel("Debit 1", { exact: true }).fill("100.00");
  await page
    .getByRole("combobox", { name: "Account 2", exact: true })
    .selectOption(equity.id);
  await page.getByLabel("Credit 2", { exact: true }).fill("90.00");
  await expect(
    page.getByRole("button", { name: "Post journal", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Credit 2", { exact: true }).fill("102.50");
  await page.getByRole("button", { name: "Add line", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Account 3", exact: true })
    .selectOption(fee.id);
  await page.getByLabel("Debit 3", { exact: true }).fill("2.50");
  await page.getByLabel("Memo 3", { exact: true }).fill("Initial fee");
  await expect(page.locator(".journal-totals")).toContainText("Balanced");
  await page.getByRole("button", { name: "Post journal", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Advanced funding", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Initial fee", { exact: true })).toBeVisible();
  const entryId = new URL(page.url()).searchParams.get("entry");
  expect(entryId).not.toBe("new");
  await page.getByRole("button", { name: "Edit journal", exact: true }).click();
  await page
    .getByLabel("Description", { exact: true })
    .fill("Adjusted advanced funding");
  await page.getByLabel("Debit 1", { exact: true }).fill("120.00");
  await page.getByLabel("Credit 2", { exact: true }).fill("122.50");
  await page.getByRole("button", { name: "Save journal", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Adjusted advanced funding",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Advanced wallet", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "General ledger", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".bookkeeping-summary")).toContainText(
    "€120.00 Dr",
  );
  await expect(
    page.getByRole("button", {
      name: "Adjusted advanced funding",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Currency", exact: true })
    .selectOption("USD");
  await expect(
    page.getByRole("heading", { name: "Choose a ledger account", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Currency", exact: true })
    .selectOption("EUR");
  await page
    .getByRole("combobox", { name: "Ledger account", exact: true })
    .selectOption(wallet.id);
  await page.getByRole("button", { name: "All history", exact: true }).click();
  await expect(page.locator(".bookkeeping-summary")).toContainText(
    "€120.00 Dr",
  );
  await page.getByLabel("From", { exact: true }).fill("2026-01-16");
  await page.getByLabel("Through", { exact: true }).fill("2026-01-31");
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect(
    page.getByText("No postings in this period.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".bookkeeping-summary")).toContainText(
    "Opening €120.00 Dr",
  );
  await menu
    .getByRole("button", { name: "Trial balance", exact: true })
    .click();
  await page.getByLabel("As of", { exact: true }).fill("2026-01-31");
  await page.getByRole("button", { name: "Apply date", exact: true }).click();
  await expect(
    page.getByRole("row").filter({
      has: page.getByRole("button", { name: "Advanced wallet", exact: true }),
    }),
  ).toContainText("€120.00");
  await menu
    .getByRole("button", { name: "Financial statements", exact: true })
    .click();
  await page.getByLabel("From", { exact: true }).fill("2026-01-01");
  await page.getByLabel("Through", { exact: true }).fill("2026-01-31");
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  const income = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Income statement", exact: true }),
  });
  await expect(
    income.getByRole("row").filter({
      has: page.getByRole("cell", { name: "Advanced fee", exact: true }),
    }),
  ).toContainText("€2.50");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    menu.getByRole("button", { name: "Journal", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.body.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await page.goto(`/advanced/journal?entry=${entryId}`);
  await expect(
    page.getByRole("button", { name: "Edit journal", exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Delete journal", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText("Manual journal deleted.");
  expect(
    (await page.request.get(`/api/accounting/journals/${entryId}`)).status(),
  ).toBe(404);
  expect(errors).toEqual([]);
});
