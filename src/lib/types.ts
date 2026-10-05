export type ExpenseKind =
  | "expense"
  | "income"
  | "refund"
  | "transfer"
  | "cash_movement"
  | "investment"
  | "pension";
export type Retailer =
  "rimi" | "partnerkaart" | "coop" | "lidl" | "wolt" | "unknown";
export type Allocation = { categoryId: string; amount: number; source: string };
export type ReceiptItem = {
  description: string;
  quantity: string | null;
  unit: string | null;
  amount: number;
  categoryId: string;
  manual: boolean;
};
export type ParsedReceipt = {
  orderId?: string;
  retailer: Retailer;
  merchant: string;
  number: string | null;
  purchasedAt: string | null;
  currency: string;
  total: number | null;
  cardAmount: number | null;
  cashAmount: number | null;
  items: ReceiptItem[];
  valid: boolean;
  issues: string[];
  text: string;
};
export type BankTransaction = {
  entry_reference?: string;
  transaction_id?: string;
  transaction_amount: { amount: string; currency: string };
  credit_debit_indicator: "CRDT" | "DBIT";
  status?: string;
  booking_date?: string;
  value_date?: string;
  transaction_date?: string;
  merchant_category_code?: string;
  bank_transaction_code?: { code?: string | null } | null;
  creditor?: { name?: string };
  debtor?: { name?: string };
  creditor_account?: { iban?: string };
  debtor_account?: { iban?: string };
  remittance_information?: string[];
  reference_number?: string;
  end_to_end_id?: string;
  [key: string]: unknown;
};
export type Bank = {
  name: string;
  country: string;
  maximum_consent_validity: number;
  required_psu_headers?: string[];
  psu_types: string[];
  logo?: string;
};
export type Rule = {
  id?: string;
  field: "merchant" | "description" | "product";
  pattern: string;
  category_id: string;
  priority: number;
  enabled: boolean;
};
export const CATEGORY_SEEDS = [
  ["groceries", "Groceries", "#447a5d"],
  ["restaurants", "Restaurants", "#ce9b56"],
  ["housing", "Housing", "#7b89aa"],
  ["utilities", "Utilities", "#b6a077"],
  ["transport", "Transport", "#6388a1"],
  ["health", "Health", "#bc808d"],
  ["household", "Household supplies", "#8b9c77"],
  ["clothing", "Clothing", "#b18ba9"],
  ["entertainment", "Entertainment", "#9c84bb"],
  ["travel", "Travel", "#6eaaa5"],
  ["subscriptions", "Subscriptions", "#848ea9"],
  ["alcohol", "Alcohol & tobacco", "#c67b62"],
  ["gifts", "Gifts", "#c595aa"],
  ["deposits", "Bottle deposits", "#8bb1a1"],
  ["investments", "Investment transfers", "#6388a1"],
  ["pension", "Pension contributions", "#7b89aa"],
  ["other", "Other spending", "#a1998a"],
  ["uncategorized", "Uncategorized", "#acb2ad"],
] as const;
