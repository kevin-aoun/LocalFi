
import { describe, expect, it } from "vitest";
import {
  categoryCashDirection,
  deriveCashBalanceCents,
  deriveCashBalancesByCurrency,
} from "@/lib/cash-balance";
import { parseAmount } from "@/lib/money";

const CATEGORIES = [
  { id: 1, type: "Income" },
  { id: 2, type: "Expense" },
  { id: 3, type: "Investment" },
];

describe("categoryCashDirection", () => {
  it("treats both expenses and investments as cash outflows", () => {
    expect(categoryCashDirection("Income")).toBe("inflow");
    expect(categoryCashDirection("Expense")).toBe("outflow");
    expect(categoryCashDirection("Investment")).toBe("outflow");
    expect(categoryCashDirection(undefined)).toBe("none");
  });
});

describe("deriveCashBalanceCents", () => {
  it("returns zero for an empty ledger", () => {
    expect(deriveCashBalanceCents([], CATEGORIES)).toBe(0);
  });

  it("adds Income and subtracts Expense and Investment", () => {
    const balance = deriveCashBalanceCents(
      [
        { categoryId: 1, amountCents: 500000 },
        { categoryId: 2, amountCents: 12050 },
        { categoryId: 3, amountCents: 10000 },
      ],
      CATEGORIES,
    );
    expect(balance).toBe(500000 - 12050 - 10000);
  });

  it("ignores pending transactions", () => {
    const balance = deriveCashBalanceCents(
      [
        { categoryId: 1, amountCents: 100000 },
        { categoryId: 2, amountCents: 5000, pending: true },
      ],
      CATEGORIES,
    );
    expect(balance).toBe(100000);
  });

  it("ignores transactions whose category no longer exists", () => {
    const balance = deriveCashBalanceCents(
      [
        { categoryId: 1, amountCents: 100000 },
        { categoryId: 999, amountCents: 5000 },
      ],
      CATEGORIES,
    );
    expect(balance).toBe(100000);
  });

  it("is exact across a ledger where float arithmetic provably drifts", () => {

    const transactions = [
      ...Array.from({ length: 1000 }, () => ({ categoryId: 1, amountCents: 10 })),
      ...Array.from({ length: 1000 }, () => ({ categoryId: 2, amountCents: 70 })),
    ];

    const floatBalance = transactions.reduce((sum, tx) => {
      const decimal = tx.amountCents / 100;
      return tx.categoryId === 1 ? sum + decimal : sum - decimal;
    }, 0);
    expect(floatBalance).not.toBe(-600);
    expect(Math.abs(floatBalance - -600)).toBeGreaterThan(0);

    expect(deriveCashBalanceCents(transactions, CATEGORIES)).toBe(-60000);
  });

  it("is exact for the classic 0.1 + 0.2 case", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(
      deriveCashBalanceCents(
        [
          { categoryId: 1, amountCents: 10 },
          { categoryId: 1, amountCents: 20 },
        ],
        CATEGORIES,
      ),
    ).toBe(30);
  });

  it("matches a hand-summed real-world-shaped ledger to the cent", () => {
    const amounts = ["10.90", "17.28", "5.86", "143.36", "7.30", "1.99", "3.99", "11.40", "5.50", "35.34", "12.18", "4.49", "4.50", "24.84", "148.11"];
    const transactions = amounts.map((a) => ({ categoryId: 2, amountCents: parseAmount(a) }));

    expect(deriveCashBalanceCents(transactions, CATEGORIES)).toBe(-43704);
  });

  it("rejects a float that leaks in instead of silently drifting", () => {
    expect(() =>
      deriveCashBalanceCents([{ categoryId: 1, amountCents: 45.5 }], CATEGORIES),
    ).toThrow(/integer number of cents/);
  });

  it("uses stored direction after category metadata changes or disappears", () => {
    expect(
      deriveCashBalanceCents(
        [
          { categoryId: 2, direction: "inflow", currency: "USD", amountCents: 10_000 },
          { categoryId: null, direction: "outflow", currency: "USD", amountCents: 2_500 },
        ],
        CATEGORIES,
      ),
    ).toBe(7_500);
  });

  it("keeps mixed denominations in separate exact buckets", () => {
    const ledger = [
      { categoryId: 1, direction: "inflow" as const, currency: "usd", amountCents: 10_000 },
      { categoryId: 2, direction: "outflow" as const, currency: "EUR", amountCents: 2_500 },
      { categoryId: 1, direction: "inflow" as const, currency: "EUR", amountCents: 8_000 },
    ];

    expect(deriveCashBalancesByCurrency(ledger, CATEGORIES)).toEqual([
      { currency: "EUR", balanceCents: 5_500 },
      { currency: "USD", balanceCents: 10_000 },
    ]);
    expect(deriveCashBalanceCents(ledger, CATEGORIES, { currency: "EUR" })).toBe(5_500);
    expect(() => deriveCashBalanceCents(ledger, CATEGORIES)).toThrow(/select one currency/);
  });
});
