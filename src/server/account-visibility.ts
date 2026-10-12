// Keep stored transactions intact while hiding ignored accounts from app reads.
export const transactionVisible =
  "EXISTS(SELECT 1 FROM accounts visible_account WHERE visible_account.id=t.account_id AND NOT visible_account.ignored)";

export const journalVisible =
  "NOT EXISTS(SELECT 1 FROM transactions hidden_transaction JOIN accounts hidden_account ON hidden_account.id=hidden_transaction.account_id WHERE hidden_transaction.id=j.transaction_id AND hidden_account.ignored)";
