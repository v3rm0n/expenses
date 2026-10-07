import { formatMoney } from "./money";

export function formatRelativeAmount(value: number, base: number): string {
  if (value === 0) return "0%";
  if (base <= 0 || !Number.isFinite(base)) return "—";
  return `${new Intl.NumberFormat("en-IE", {
    maximumFractionDigits: 1,
  }).format((value / base) * 100)}%`;
}

export function amountFormatter(
  currency: string,
  percentages: boolean,
  base: number,
) {
  return (value: number) =>
    percentages
      ? formatRelativeAmount(value, base)
      : formatMoney(value, currency);
}
