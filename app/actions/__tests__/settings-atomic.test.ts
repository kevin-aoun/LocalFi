
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDb, seedQuickCommand, type TempDb } from "./support/temp-db";

vi.mock("next/cache", () => ({
  revalidatePath: () => {
    throw new Error("Invariant: static generation store missing");
  },
}));

const { getSettings, updateSettings } = await import("../settings");
const { saveDb } = await import("@/lib/db/client");

let temp: TempDb;

beforeEach(async () => {
  temp = await createTempDb();
});

afterEach(async () => {
  await temp.cleanup();
});

const storedCommands = () =>
  temp.query("SELECT command, category_name, amount_cents, comment FROM quick_commands ORDER BY command");

const base = {
  userName: "Test User",
  accentColor: "default",
  theme: "system" as const,
  showLedger: false,
};

describe("updateSettings is atomic", () => {
  it("replaces the whole quick-command list in one write", async () => {
    seedQuickCommand(temp, { command: "old", categoryName: "Groceries", amountCents: 100, comment: "x" });

    const result = await updateSettings({
      ...base,
      quickCommands: [
        { id: 1, command: "coffee", categoryName: "Coffee", amountCents: 350, comment: "Latte" },
        { id: 2, command: "salary", categoryName: "Salary", amountCents: 500000, comment: "Monthly" },
      ],
    });

    expect(result).toEqual({ success: true });
    expect(storedCommands()).toEqual([
      { command: "coffee", category_name: "Coffee", amount_cents: 350, comment: "Latte" },
      { command: "salary", category_name: "Salary", amount_cents: 500000, comment: "Monthly" },
    ]);
  });

  it("keeps EVERY existing command when one of the new ones is invalid", async () => {
    seedQuickCommand(temp, { command: "coffee", categoryName: "Coffee", amountCents: 350, comment: "Latte" });
    seedQuickCommand(temp, { command: "rent", categoryName: "Rent", amountCents: 120000, comment: "Rent" });

    const result = await updateSettings({
      ...base,
      quickCommands: [
        { id: 1, command: "coffee", categoryName: "Coffee", amountCents: 350, comment: "Latte" },

        { id: 2, command: "broken", categoryName: "Rent", amountCents: 12.5, comment: "Rent" },
        { id: 3, command: "salary", categoryName: "Salary", amountCents: 500000, comment: "Monthly" },
      ],
    });

    expect(result).toMatchObject({ error: expect.stringContaining("integer number of cents") });

    expect(storedCommands()).toEqual([
      { command: "coffee", category_name: "Coffee", amount_cents: 350, comment: "Latte" },
      { command: "rent", category_name: "Rent", amount_cents: 120000, comment: "Rent" },
    ]);
  });

  it("a later unrelated flush cannot resurrect a half-applied update", async () => {
    seedQuickCommand(temp, { command: "coffee", categoryName: "Coffee", amountCents: 350, comment: "Latte" });
    seedQuickCommand(temp, { command: "rent", categoryName: "Rent", amountCents: 120000, comment: "Rent" });

    await updateSettings({
      ...base,
      quickCommands: [{ id: 1, command: "broken", categoryName: "X", amountCents: 0.5, comment: "" }],
    });

    await saveDb();

    expect(storedCommands()).toEqual([
      { command: "coffee", category_name: "Coffee", amount_cents: 350, comment: "Latte" },
      { command: "rent", category_name: "Rent", amount_cents: 120000, comment: "Rent" },
    ]);
  });

  it("rejects the update before touching the database, not during it", async () => {
    seedQuickCommand(temp, { command: "coffee", categoryName: "Coffee", amountCents: 350, comment: "Latte" });

    await updateSettings({
      ...base,
      userName: "Should Not Be Saved",
      quickCommands: [{ id: 1, command: "broken", categoryName: "X", amountCents: 1.5, comment: "" }],
    });

    const settings = await getSettings();
    expect(settings.userName).toBe("");
    expect(settings.quickCommands.map((c) => c.command)).toEqual(["coffee"]);
  });

  it("clears the list when asked to, and only then", async () => {
    seedQuickCommand(temp, { command: "coffee", categoryName: "Coffee", amountCents: 350, comment: "Latte" });

    expect(await updateSettings({ ...base, quickCommands: [] })).toEqual({ success: true });
    expect(storedCommands()).toEqual([]);
  });

  it("round-trips the settings row itself", async () => {
    const result = await updateSettings({
      userName: "Test User",
      accentColor: "#a855f7",
      theme: "dark",
      showLedger: true,
      quickCommands: [],
    });

    expect(result).toEqual({ success: true });
    const settings = await getSettings();
    expect(settings).toMatchObject({
      userName: "Test User",
      accentColor: "#a855f7",
      theme: "dark",
      showLedger: true,
    });
  });

  it("defaults the explorer preference off when no settings row exists", async () => {
    await expect(getSettings()).resolves.toMatchObject({ showLedger: false });
  });

  it("keeps the preference and quick commands in the same atomic update", async () => {
    seedQuickCommand(temp, {
      command: "coffee",
      categoryName: "Coffee",
      amountCents: 350,
      comment: "Latte",
    });

    const result = await updateSettings({
      ...base,
      showLedger: true,
      quickCommands: [
        { id: 1, command: "broken", categoryName: "X", amountCents: 1.5, comment: "" },
      ],
    });

    expect(result).toMatchObject({ error: expect.any(String) });
    await expect(getSettings()).resolves.toMatchObject({ showLedger: false });
    expect(storedCommands()).toEqual([
      { command: "coffee", category_name: "Coffee", amount_cents: 350, comment: "Latte" },
    ]);
  });
});
