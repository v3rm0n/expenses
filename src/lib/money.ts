export function currencyScale(currency: string): number {
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Invalid currency code");
  return (
    new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits ?? 2
  );
}
export function parseMoney(value: string | number, currency = "EUR"): number {
  let normalized = String(value)
    .trim()
    .replace(/[\s\u00a0]/g, "")
    .replace(/−/g, "-");
  if (normalized.includes(","))
    normalized = normalized.includes(".")
      ? normalized.replace(/\./g, "").replace(",", ".")
      : normalized.replace(",", ".");
  const match = normalized.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error("Enter an amount such as 12.50");
  const scale = currencyScale(currency);
  const decimals = match[3] || "";
  if (decimals.length > scale && /[1-9]/.test(decimals.slice(scale)))
    throw new Error(`Amounts in ${currency} support ${scale} decimal places`);
  const result =
    BigInt(match[2]) * 10n ** BigInt(scale) +
    BigInt(decimals.slice(0, scale).padEnd(scale, "0") || "0");
  const signed = match[1] === "-" ? -result : result;
  if (
    signed > BigInt(Number.MAX_SAFE_INTEGER) ||
    signed < BigInt(Number.MIN_SAFE_INTEGER)
  )
    throw new Error("Amount is too large");
  return Number(signed);
}
export function decimalMoney(amount: number, currency = "EUR"): string {
  const scale = currencyScale(currency);
  const digits = String(Math.abs(amount)).padStart(scale + 1, "0");
  return `${amount < 0 ? "-" : ""}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`;
}
export function formatMoney(amount: number, currency = "EUR"): string {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency }).format(
    amount / 10 ** currencyScale(currency),
  );
}
export function prorate(amounts: number[], target: number): number[] {
  if (
    !Number.isSafeInteger(target) ||
    amounts.some((x) => !Number.isSafeInteger(x))
  )
    throw new Error("Invalid allocation");
  const total = amounts.reduce((a, b) => a + b, 0);
  if (!total) {
    if (target === 0) return amounts.map(() => 0);
    throw new Error("Cannot split a zero total");
  }
  const shares = amounts.map((amount) =>
    Number((BigInt(amount) * BigInt(target)) / BigInt(total)),
  );
  let remaining = target - shares.reduce((a, b) => a + b, 0);
  const order = amounts
    .map((amount, i) => ({
      i,
      fraction:
        Number((BigInt(amount) * BigInt(target)) % BigInt(total)) / total,
    }))
    .sort((a, b) =>
      remaining > 0 ? b.fraction - a.fraction : a.fraction - b.fraction,
    );
  for (let i = 0; remaining; i++) {
    const step = Math.sign(remaining);
    shares[order[i % order.length].i] += step;
    remaining -= step;
  }
  return shares;
}
export function validDate(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value
  )
    throw new Error("Invalid date");
  return value;
}
