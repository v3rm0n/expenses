import { Suspense } from "react";
import ExpenseApp from "@/components/expense-app";
export default function Page() {
  return (
    <Suspense fallback={<div className="loading">Opening your workspace…</div>}>
      <ExpenseApp />
    </Suspense>
  );
}
