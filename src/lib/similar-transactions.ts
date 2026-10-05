import { normalize } from "./classification";

// Bank references and billing-period suffixes change on recurring payments.
export function suggestedDescriptionPattern(description: string): string {
  return description
    .split(" · ")
    .at(-1)!
    .replace(/^\d+-/, "")
    .split(" - ")[0]
    .trim()
    .slice(0, 200);
}

export function matchesSimilarTransaction(
  entry: { merchant: string; description: string },
  merchant: string,
  pattern: string,
): boolean {
  return (
    normalize(entry.merchant) === normalize(merchant) &&
    (!normalize(pattern) ||
      normalize(entry.description).includes(normalize(pattern)))
  );
}
