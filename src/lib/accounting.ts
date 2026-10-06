export const ACCOUNT_TYPES = [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export type JournalInput = {
  currency: string;
  date: string;
  description: string;
  reference: string;
  notes: string;
  postings: {
    accountId: string;
    debit: string | number;
    credit: string | number;
    memo: string;
  }[];
};
export type AccountingAccount = {
  id: string;
  code: string;
  display_code: string | null;
  name: string;
  type: AccountType;
  currency: string;
  balance: number;
  debit: number;
  credit: number;
  opening_balance: number;
  opening_date: string | null;
  first_date: string | null;
};
export type TrialBalance = {
  currency: string;
  through: string | null;
  accounts: AccountingAccount[];
  debit: number;
  credit: number;
  balance_debit: number;
  balance_credit: number;
};
export type JournalPosting = {
  id: string;
  account_id: string;
  name: string;
  code: string;
  type: AccountType;
  amount: number;
  debit: number;
  credit: number;
  memo: string;
};
export type Journal = {
  id: string;
  transaction_id: string | null;
  opening_account_id: string | null;
  manual_key: string | null;
  currency: string;
  booked_at: string;
  description: string;
  reference: string;
  notes: string;
  version: number;
  origin: "manual" | "transaction" | "opening";
  debit: number;
  credit: number;
};
export type JournalDetail = { journal: Journal; postings: JournalPosting[] };
export type JournalPage = {
  rows: Journal[];
  count: number;
  page: number;
  limit: number;
};
export type LedgerRow = {
  id: string;
  entry_id: string;
  booked_at: string;
  description: string;
  reference: string;
  origin: Journal["origin"];
  memo: string;
  debit: number;
  credit: number;
  balance: number;
};
export type GeneralLedger = {
  account: Pick<
    AccountingAccount,
    "id" | "code" | "display_code" | "name" | "type" | "currency"
  >;
  rows: LedgerRow[];
  page: number;
  limit: number;
  count: number;
  opening: number;
  closing: number;
  debit: number;
  credit: number;
};
