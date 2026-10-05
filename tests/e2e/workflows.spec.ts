import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  receiptText,
  amazonOrderId,
  amazonReceiptText,
  textPdf,
} from "../fixtures";
const password = "only-for-isolated-test-db";
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
  const today = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Tallinn",
  }).format(new Date());
  await page.getByRole("button", { name: "Transactions", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Transactions", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cash entry", exact: true }).click();
  const dialog = page.getByRole("dialog");
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
  await page.getByLabel("Month", { exact: true }).fill(today.slice(0, 7));
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

test("investment and pension classifications update the overview and fit a phone", async ({
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
  await page.getByLabel("Month", { exact: true }).fill("2026-08");
  await page.reload();
  await expect(page.getByLabel("Month", { exact: true })).toHaveValue(
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
  await page.goto("/login");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
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
  await page.goto("/login");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
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
