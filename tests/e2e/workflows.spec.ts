import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { receiptText } from "../fixtures";
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
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Receipt email bridge" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reveal bridge token" }).click();
  await expect(page.locator(".secret-field")).toHaveText(
    "expenses-test-email-token-only",
  );
  await page.getByRole("button", { name: "Hide bridge token" }).click();
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
  await page.getByRole("button", { name: "Review", exact: true }).click();
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
