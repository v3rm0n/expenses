import type { Rule, ExpenseKind } from "./types";
export const normalize = (value: string) =>
  value.normalize("NFKC").toLocaleLowerCase("et").replace(/\s+/g, " ").trim();
export function matchingRule(
  rules: Rule[],
  merchant: string,
  description: string,
  product?: string,
): Rule | undefined {
  return rules
    .filter(
      (rule) =>
        rule.enabled && (rule.field !== "product" || product !== undefined),
    )
    .sort((a, b) => a.priority - b.priority)
    .find((rule) =>
      normalize(
        rule.field === "merchant"
          ? merchant
          : rule.field === "product"
            ? product!
            : description,
      ).includes(normalize(rule.pattern)),
    );
}
export function merchantCategory(
  merchant: string,
  description = "",
  mcc?: string,
): string {
  const text = normalize(`${merchant} ${description}`);
  const patterns: [RegExp, string][] = [
    [
      /netflix|spotify|apple\.com\/bill|youtube premium|adobe|icloud|openai/,
      "subscriptions",
    ],
    [
      /bolt food|wolt|restoran|restaurant|kohvik|cafe|mcdonald|hesburger|pizza/,
      "restaurants",
    ],
    [
      /bolt|uber|taxi|tallinna transport|elron|circle k|alexela|neste|o.m.v/,
      "transport",
    ],
    [/apteek|apotheka|benu|südameapteek|hambaarst|clinic|kliinik/, "health"],
    [/rimi|selver|delice|coop|lidl|prisma|maxima|grossi/, "groceries"],
    [
      /eesti energia|enefit|elektrum|elektrilevi|telia|elisa|tele2|tallinna vesi/,
      "utilities",
    ],
    [/booking\.com|airbnb|ryanair|airbaltic|finnair|hotel|hotell/, "travel"],
    [/h&m|zara|reserved|uniqlo/, "clothing"],
    [/apollo kino|cinamon|piletilevi|steam/, "entertainment"],
  ];
  const found = patterns.find(([pattern]) => pattern.test(text));
  if (found) return found[1];
  if (mcc) {
    const mappings: Record<string, string> = {
      "5411": "groceries",
      "5812": "restaurants",
      "5814": "restaurants",
      "5541": "transport",
      "4111": "transport",
      "5912": "health",
      "5311": "other",
      "5734": "subscriptions",
    };
    if (mappings[mcc]) return mappings[mcc];
  }
  return "uncategorized";
}
export function productCategory(description: string): string {
  const text = normalize(description);
  if (
    /pant|taara|deposit|pfand|metallist ühekorrapakend|\b(?:metall|plast|klaas)pakend\s+[a-d]\b/.test(
      text,
    )
  )
    return "deposits";
  if (
    /õlu|olu\b|beer|vein|wine|viin|vodka|siider|cider|gin\b|whisky|whiskey|tubak|sigaret/.test(
      text,
    )
  )
    return "alcohol";
  if (
    /pesuvah|pesupulb|nõudepes|puhast|detergent|cleaner|tualettpaber|majapidam|prügikott|ostukott|poekott|kilekott|šampoon|shampoo|seep|hambahari|hambavahepuhasti|hügieeniside|hilgieeniside|libresse|tampoon|patarei|paterei|energizer/.test(
      text,
    )
  )
    return "household";
  if (
    /piim|milk|leib|sai\b|bread|juust|cheese|jogurt|yogurt|keefir|kohupiim|või\b|butter|muna|egg|kana|chicken|liha|meat|veis|pork|sealiha|kala|fish|lõhe|salmon|vorst|sink|ham\b|õun|apple|avokaado|banaan|banana|ananas|pineapple|coca[ -]?cola|limonaad|karastusjook|tomat|tomato|kartul|kart\.?\s*krõp|potato|porgand|carrot|kurk|cucumber|sibul|onion|küüslauk|garlic|lasanje|kaste|salat|salad|marj|maasik|mustik|puuvil|juurvil|pasta|makaron|riis|rice|jahu|flour|suhkur|sugar|sool|salt|kohv|coffee|tee\b|tea\b|mahl|juice|vesi|water|šokolaad|chocolate|küpsis|biscuit|pähkel|nuts|jäätis|jaatis|jääkuub|jaakuub|jäakuub|ice cream|helbed|cereal|tatra|kaera|puder|aedvi|õli|oil\b|ketšup|ketchup|toit|söök/.test(
      text,
    )
  )
    return "groceries";
  return "uncategorized";
}
export function transactionKind(
  direction: "CRDT" | "DBIT",
  description: string,
  ownTransfer: boolean,
  bankTransactionCode?: string | null,
): ExpenseKind {
  if (direction === "DBIT") {
    const capital = contributionKind(description);
    if (capital) return capital;
  }
  if (ownTransfer) return "transfer";
  const code = bankTransactionCode?.toUpperCase();
  // Card-funded wallet top-ups omit the sending account's IBAN. TOPUP also
  // labels ordinary incoming bank payments, so require the card descriptor.
  if (
    code === "EXCHANGE" ||
    (direction === "CRDT" &&
      code === "TOPUP" &&
      /\b(?:Apple Pay|Google Pay|Card)\s+Top[- ]?Up\s+by\s+\*\d{4}\s*$/i.test(
        description,
      ))
  )
    return "transfer";
  if (
    /cash withdrawal|sularaha väljav|sularahaautomaat|atm withdrawal/i.test(
      description,
    )
  )
    return "cash_movement";
  if (direction === "DBIT") return "expense";
  return /refund|tagastus|tagasimakse|return payment/i.test(description)
    ? "refund"
    : "income";
}

export function contributionKind(
  description: string,
): "investment" | "pension" | null {
  const text = normalize(description);
  if (/\btuleva\b/.test(text)) return "investment";
  if (
    /\bpensionikeskus\b|\bpensionifond\b|\bpension fund\b|\bpension contribution\b|\bpensionimakse\b|\biii\s+(?:samba|sammas)\b/.test(
      text,
    )
  )
    return "pension";
  if (
    /\blightyear\b|\binteractive brokers\b|\binvesteerimiskonto\b|\binvestment account\b|\binvestment contribution\b/.test(
      text,
    )
  )
    return "investment";
  return null;
}
export function contributionCategory(kind: string): string | null {
  return kind === "investment"
    ? "investments"
    : kind === "pension"
      ? "pension"
      : null;
}
export function allocationAmount(kind: string, amount: number): number {
  return ["expense", "refund", "investment", "pension"].includes(kind)
    ? -amount
    : 0;
}
