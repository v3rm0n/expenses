import { Suspense } from "react";
import { notFound } from "next/navigation";
import ExpenseApp from "@/components/expense-app";
export default async function Page({
  params,
}: {
  params: Promise<{ page: string[] }>;
}) {
  const { page } = await params;
  if (
    ![
      "transactions",
      "receipts",
      "review",
      "connections",
      "rules",
      "settings",
      "login",
      "setup",
    ].includes(page[0]) ||
    page.length > 2
  )
    notFound();
  return (
    <Suspense fallback={<div className="loading">Loading…</div>}>
      <ExpenseApp />
    </Suspense>
  );
}
