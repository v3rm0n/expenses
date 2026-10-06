import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import ExpenseApp from "@/components/expense-app";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ page: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { page } = await params;
  if (page[0] === "six-month" && page.length === 1) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(await searchParams))
      if (typeof value === "string") query.set(key, value);
    if (!query.has("months")) query.set("months", "6");
    redirect(`/?${query}`);
  }
  if (
    ![
      "six-month",
      "transactions",
      "receipts",
      "review",
      "connections",
      "rules",
      "settings",
      "advanced",
      "login",
      "setup",
    ].includes(page[0]) ||
    (page[0] === "six-month" && page.length !== 1) ||
    (page[0] === "advanced" &&
      page[1] &&
      ![
        "journal",
        "ledger",
        "trial-balance",
        "accounts",
        "statements",
      ].includes(page[1])) ||
    page.length > 2
  )
    notFound();
  return (
    <Suspense fallback={<div className="loading">Loading…</div>}>
      <ExpenseApp />
    </Suspense>
  );
}
