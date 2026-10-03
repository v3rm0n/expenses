import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Expenses",
  description: "Transactions, receipts, and spending",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
