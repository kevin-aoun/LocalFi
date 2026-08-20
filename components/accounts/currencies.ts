
export const SUPPORTED_CURRENCIES = [
  { code: "AED", name: "UAE dirham", icon: "د.إ" },
  { code: "AUD", name: "Australian dollar", icon: "A$" },
  { code: "CAD", name: "Canadian dollar", icon: "C$" },
  { code: "CHF", name: "Swiss franc", icon: "Fr" },
  { code: "CNY", name: "Chinese yuan", icon: "¥" },
  { code: "DKK", name: "Danish krone", icon: "kr" },
  { code: "EUR", name: "Euro", icon: "€" },
  { code: "GBP", name: "British pound", icon: "£" },
  { code: "HKD", name: "Hong Kong dollar", icon: "HK$" },
  { code: "ILS", name: "Israeli new shekel", icon: "₪" },
  { code: "INR", name: "Indian rupee", icon: "₹" },
  { code: "JPY", name: "Japanese yen", icon: "¥" },
  { code: "LBP", name: "Lebanese pound", icon: "ل.ل" },
  { code: "NOK", name: "Norwegian krone", icon: "kr" },
  { code: "NZD", name: "New Zealand dollar", icon: "NZ$" },
  { code: "PLN", name: "Polish złoty", icon: "zł" },
  { code: "SAR", name: "Saudi riyal", icon: "﷼" },
  { code: "SEK", name: "Swedish krona", icon: "kr" },
  { code: "TRY", name: "Turkish lira", icon: "₺" },
  { code: "USD", name: "US dollar", icon: "$" },
] as const;

export type SupportedCurrencyCode = (typeof SUPPORTED_CURRENCIES)[number]["code"];

const CURRENCY_BY_CODE = new Map(SUPPORTED_CURRENCIES.map((currency) => [currency.code, currency]));

export function normalizeAccountCurrency(value: string | null | undefined): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const aliases: Record<string, SupportedCurrencyCode> = {
    aed: "AED",
    "uae dirham": "AED",
    dirham: "AED",
    sar: "SAR",
    "saudi riyal": "SAR",
    riyal: "SAR",
    try: "TRY",
    "turkish lira": "TRY",
    lira: "TRY",
  };
  return aliases[raw] ?? raw.toUpperCase();
}

export function isSupportedCurrency(value: string | null | undefined): value is SupportedCurrencyCode {
  return CURRENCY_BY_CODE.has(normalizeAccountCurrency(value) as SupportedCurrencyCode);
}

export function currencyOption(value: string | null | undefined) {
  return CURRENCY_BY_CODE.get(normalizeAccountCurrency(value) as SupportedCurrencyCode);
}
