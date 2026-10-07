import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { emptyPlan } from "../../src/lib/spending-plan";
import { mkdir } from "node:fs/promises";

const headers = { Origin: "http://127.0.0.1:4318" };
const password = "only-for-isolated-test-db";

test("planning endpoints require an owner session and same-origin writes", async ({
  request,
}) => {
  expect((await request.get("/api/financial-overview")).status()).toBe(401);
  expect((await request.get("/api/spending-plan")).status()).toBe(401);
  expect(
    (
      await request.post("/api/spending-plan", {
        headers,
        data: { month: "2026-10", currency: "EUR", plan: emptyPlan() },
      })
    ).status(),
  ).toBe(401);
  expect(
    (
      await request.post("/api/spending-plan", {
        data: { month: "2026-10", currency: "EUR", plan: emptyPlan() },
      })
    ).status(),
  ).toBe(403);
});

test("spending plans persist, update allowance and annual goals, and work on narrow screens", async ({
  page,
}) => {
  const status = await (await page.request.get("/api/auth/status")).json();
  expect(
    (
      await page.request.post(
        status.needsSetup ? "/api/auth/setup" : "/api/auth/login",
        {
          headers,
          data: status.needsSetup
            ? {
                name: "Test owner",
                password,
                token: "expenses-test-setup-token-only",
              }
            : { password },
        },
      )
    ).ok(),
  ).toBe(true);
  const today = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Tallinn",
  }).format(new Date());
  const month = today.slice(0, 7);
  const monthNumber = Number(month.slice(5, 7));
  async function entry(amount: string, kind: string, date = today) {
    const response = await page.request.post("/api/transactions", {
      headers,
      data: {
        merchant: `Plan test ${kind}`,
        amount,
        kind: kind === "income" ? "income" : "expense",
        date,
        currency: "CHF",
        category: kind === "expense" ? "groceries" : "uncategorized",
        idempotencyKey: randomUUID(),
      },
    });
    expect(response.status()).toBe(201);
    const result = await response.json();
    if (["investment", "pension"].includes(kind))
      expect(
        (
          await page.request.post(`/api/transactions/${result.id}`, {
            headers,
            data: { kind, category: "uncategorized" },
          })
        ).ok(),
      ).toBe(true);
  }
  await entry("2500", "income");
  await entry("400", "expense");
  await entry("100", "investment");
  await entry("50", "pension");
  if (monthNumber > 1) {
    await entry(
      String(300 * (monthNumber - 1)),
      "investment",
      `${month.slice(0, 4)}-01-01`,
    );
    await entry(
      String(150 * (monthNumber - 1)),
      "pension",
      `${month.slice(0, 4)}-01-01`,
    );
  }
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`/?month=${month}&currency=CHF`);
  await expect(
    page.getByRole("heading", { name: "Goal progress" }),
  ).toBeVisible();
  await expect(page.getByLabel("Period length")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Top merchants" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Receipt coverage" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Edit spending plan" }).click();
  await page.getByLabel("Expected take-home income").fill("2500");
  await page.getByLabel("Monthly living-expense limit").fill("1800");
  await page.getByLabel("Cash buffer", { exact: true }).fill("100");
  await page.getByLabel("Monthly investment target").fill("300");
  await page.getByLabel("Monthly pension target").fill("150");
  await page
    .getByLabel(`Investment target for ${month.slice(0, 4)}`)
    .fill("3600");
  await page.getByLabel(`Pension target for ${month.slice(0, 4)}`).fill("1800");
  await page.getByRole("button", { name: "Add category limit" }).click();
  await page.getByLabel("Budget category 1").selectOption("groceries");
  await page.getByLabel("Budget amount 1").fill("500");
  await page.getByRole("button", { name: "Add bill", exact: true }).click();
  await page.getByLabel("Bill name 1").fill("Electricity");
  await page.getByLabel("Bill amount 1").fill("200");
  await page.getByLabel("Bill due day 1").fill("10");
  await page.getByLabel("Bill category 1").selectOption("utilities");
  await page.getByLabel("Cash balance before pending payments").fill("500");
  await page.getByLabel("Next payday", { exact: true }).fill(`${month}-28`);
  await page.getByRole("button", { name: "Save spending plan" }).click();
  await expect(
    page.getByText(
      "Plan saved. Overview estimates and goal progress are updated.",
    ),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Expected take-home income")).toHaveValue(
    "2500.00",
  );
  await expect(page.getByLabel("Bill name 1")).toHaveValue("Electricity");
  const response = await page.request.get(
    `/api/financial-overview?month=${month}&currency=CHF`,
  );
  expect(response.ok()).toBe(true);
  const data = await response.json();
  expect(data.outlook.allowance).toBe(120000);
  expect(data.outlook.surplus).toBe(210000);
  expect(data.outlook.afterContributions).toBe(195000);
  expect(data.outlook.investment.remaining).toBe(20000);
  expect(data.outlook.pension.remaining).toBe(10000);
  expect(data.outlook.cashBeforePayday).toBe(20000);
  expect(data.cashUpdatedAt).not.toBeNull();
  await page.getByRole("button", { name: "Back to overview" }).click();
  await expect(page.getByLabel("Spending allowance")).toContainText("1,200.00");
  await expect(page.locator(".commitment-list")).toContainText("Electricity");
  await mkdir(".data/screenshots", { recursive: true });
  await page.screenshot({
    path: ".data/screenshots/planning-overview.png",
    fullPage: true,
  });
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Edit spending plan" }).click();
    await expect(
      page.getByRole("button", { name: "Save spending plan" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (width === 390)
      await page.screenshot({
        path: ".data/screenshots/planning-goals-phone.png",
        fullPage: true,
      });
    await page.getByRole("button", { name: "Back to overview" }).click();
  }
  const otherCurrency = await (
    await page.request.get(`/api/spending-plan?month=${month}&currency=JPY`)
  ).json();
  expect(otherCurrency.saved).toBe(false);
  expect(otherCurrency.plan.income).toBeNull();
  const next = new Date(`${month}-01T12:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const nextMonth = next.toISOString().slice(0, 7);
  await page.goto(`/goals?month=${nextMonth}&currency=CHF`);
  await expect(page.getByLabel("Expected take-home income")).toHaveValue("");
  await page.getByRole("button", { name: "Copy previous month" }).click();
  await expect(page.getByLabel("Expected take-home income")).toHaveValue(
    "2500.00",
  );
  await expect(page.getByLabel("Bill status 1")).toHaveValue("unpaid");
  await expect(
    page.getByLabel("Cash balance before pending payments"),
  ).toHaveValue("");
  await page.getByRole("button", { name: "Save spending plan" }).click();
  await expect(
    page.getByText(
      "Plan saved. Overview estimates and goal progress are updated.",
    ),
  ).toBeVisible();
  const annual = await (
    await page.request.get(
      `/api/spending-plan?month=${month.slice(0, 4)}-01&currency=CHF`,
    )
  ).json();
  expect(annual.plan.investmentAnnual).toBe(360000);
  await page.goto(`/analysis?month=${month}&currency=CHF&months=6`);
  await expect(
    page.getByRole("heading", { name: "Top merchants" }),
  ).toBeVisible();
  await expect(page.getByLabel("Period length")).toHaveValue("6");
  const percentageSwitch = page.getByRole("switch", {
    name: "Show percentages",
  });
  await expect(percentageSwitch).toHaveAttribute("aria-checked", "false");
  await percentageSwitch.click();
  await expect(percentageSwitch).toHaveAttribute("aria-checked", "true");
  const assertNoAmounts = async () => {
    const content = await page
      .locator("main")
      .evaluate((main) =>
        [
          main.textContent,
          ...Array.from(
            main.querySelectorAll("[aria-label], [title]"),
            (element) =>
              `${element.getAttribute("aria-label")} ${element.getAttribute("title")}`,
          ),
        ].join(" "),
      );
    expect(content).not.toMatch(/CHF\s*-?[\d,]+(?:\.\d+)?/);
    expect(content).not.toMatch(/NaN|Infinity/);
  };
  await expect(page.locator(".metric-value").first()).toHaveText("100%");
  await page.locator(".analysis-chart [role=button]").first().focus();
  await expect(page.locator(".analysis-chart-detail").first()).toContainText(
    "%",
  );
  await assertNoAmounts();
  await page.getByRole("button", { name: /1\. Plan test expense/ }).click();
  await expect(page.locator(".analysis-merchant-detail")).toContainText("%");
  await assertNoAmounts();
  await page.goto(`/?month=${month}&currency=CHF`);
  await expect(percentageSwitch).toHaveAttribute("aria-checked", "true");
  await expect(
    page.locator(".financial-metrics .metric-value").first(),
  ).toHaveText("16%");
  await assertNoAmounts();
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(percentageSwitch).toBeVisible();
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.getByLabel("Currency", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Currency", { exact: true })).toHaveValue(
      "CHF",
    );
    if (width === 320) {
      await page.getByLabel("Currency", { exact: true }).selectOption("EUR");
      await expect(page).toHaveURL(/currency=EUR/);
      await page.getByLabel("Currency", { exact: true }).selectOption("CHF");
      await expect(page).toHaveURL(/currency=CHF/);
    }
    await page.getByRole("button", { name: "Close menu" }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.screenshot({
    path: ".data/screenshots/planning-overview-percentages.png",
    fullPage: true,
  });
  await percentageSwitch.click();
  await expect(
    page.locator(".financial-metrics .metric-value").first(),
  ).toContainText("400.00");

  await page.goto(`/receipts?month=${month}&currency=CHF`);
  await expect(
    page.getByRole("heading", { name: "Receipt coverage" }),
  ).toBeVisible();
  for (const plan of [
    { ...emptyPlan(), income: -1 },
    { ...emptyPlan(), income: 1.5 },
    {
      ...emptyPlan(),
      budgets: [
        { categoryId: "missing-category", amount: 100, flexible: true },
      ],
    },
    {
      ...emptyPlan(),
      budgets: [
        { categoryId: "groceries", amount: 100, flexible: true },
        { categoryId: "groceries", amount: 100, flexible: true },
      ],
    },
  ]) {
    expect(
      (
        await page.request.post("/api/spending-plan", {
          headers,
          data: { month, currency: "CHF", plan },
        })
      ).status(),
    ).toBe(400);
  }
  expect(
    (await page.request.get("/api/financial-overview?month=2026-13")).status(),
  ).toBe(400);
  expect(pageErrors).toEqual([]);
});
