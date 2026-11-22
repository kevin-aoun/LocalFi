import { canonicalDecimal, divideRoundHalfUp } from "@/lib/ledger/decimal";
import { assertCents, sumCents, type Cents } from "@/lib/money";
import type { InvestmentSide } from "./trades";

/** The cash a trade moves. A gift is a buy whose price records its value but bills only the fees. */
export function tradeCashAmount(quantity: string, unitPrice: string, fees: Cents, side: InvestmentSide, gift = false): Cents {
  assertCents(fees);
  if (fees < 0) throw new Error("Fees cannot be negative");
  const gross = purchaseAmountCents(quantity, unitPrice);
  if (gift) {
    if (side === "sell") throw new Error("Only a buy can be a gift.");
    return fees;
  }
  const net = sumCents([gross, side === "sell" ? -fees : fees]);
  if (net < 0) throw new Error("Sale fees cannot exceed the sale proceeds");
  return net;
}

export function parsePurchaseQuantity(value: string): string {
  const quantity = canonicalDecimal(value.trim().replace(/^([+-]?)\./, (_match, sign: string) => `${sign}0.`));
  if (quantity === "0" || quantity.startsWith("-")) throw new Error("Enter a positive number of shares or coins.");
  return quantity;
}

export function parsePurchaseUnitPrice(value: string): string {
  const price = canonicalDecimal(value);
  if (price === "0" || price.startsWith("-") || (price.split(".")[1]?.length ?? 0) > 4) {
    throw new Error("Enter a positive price per unit with up to four decimal places.");
  }
  return price;
}

// Prices are rates, so keep their decimal precision until the final cash value.
export function quantityValueMinor(quantity: string, unitPriceMinor: Cents, unitPrice?: string | null): Cents {
  assertCents(unitPriceMinor);
  const exactQuantity = canonicalDecimal(quantity);
  const exactPrice = canonicalDecimal(unitPrice ?? String(unitPriceMinor));
  const [whole, fraction = ""] = exactQuantity.replace(/^-/, "").split(".");
  const [priceWhole, priceFraction = ""] = exactPrice.replace(/^-/, "").split(".");
  const denominator = BigInt(10) ** BigInt(fraction.length + priceFraction.length);
  const numerator = BigInt(whole + fraction) * BigInt(priceWhole + priceFraction) * (unitPrice == null ? BigInt(1) : BigInt(100));
  const rounded = divideRoundHalfUp(numerator, denominator);
  const result = Number(exactQuantity.startsWith("-") !== exactPrice.startsWith("-") ? -rounded : rounded);
  assertCents(result);
  return result;
}

export function purchaseAmountCents(quantity: string, unitPrice: string): Cents {
  const exact = parsePurchaseQuantity(quantity);
  const amount = quantityValueMinor(exact, 0, parsePurchaseUnitPrice(unitPrice));
  if (amount <= 0) throw new Error("The purchase total must be at least one cent.");
  return amount;
}

export function unitPriceFromAmountCents(paidAmount: Cents, quantity: string): string {
  assertCents(paidAmount);
  const exact = canonicalDecimal(quantity);
  if (paidAmount <= 0 || exact === "0" || exact.startsWith("-")) {
    throw new Error("Enter a positive purchase amount and quantity.");
  }
  const [whole, fraction = ""] = exact.split(".");
  const denominator = BigInt(whole + fraction);
  const numerator = BigInt(paidAmount) * BigInt(10) ** BigInt(fraction.length + 2);
  const rounded = divideRoundHalfUp(numerator, denominator);
  const digits = rounded.toString().padStart(5, "0");
  return canonicalDecimal(`${digits.slice(0, -4)}.${digits.slice(-4)}`);
}
