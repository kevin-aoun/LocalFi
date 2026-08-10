"use server";

/**
 * Recurring transactions: templates for rent, salary and subscriptions, plus the
 * materialiser that turns them into real ledger rows.
 *
 * ## Why this is the most dangerous action in the app
 *
 * A generator that posts one occurrence too many silently invents money; one that
 * posts one too few silently loses it; and either mistake compounds every month.
 * So idempotency here rests on THREE independent things, in order of strength:
 *
 *   1. A partial UNIQUE index on `transactions(recurring_id, recurring_occurrence)`
 *      — the database itself rejects a second row for the same (template, day).
 *   2. An explicit existence check before each insert, so a re-run reports
 *      `skipped` instead of raising a constraint error.
 *   3. The `last_generated` cursor, which makes the common case cheap.
 *
 * Occurrence dates come from lib/recurrence.ts, which computes them from the
 * template's ANCHOR (`start_date`) by index — so "the 31st" clamps to Feb 28 for
 * February only and returns to the 31st in March, instead of drifting to the 28th
 * forever.
 *
 * Generation runs inside ONE `withDb` call, so either every due occurrence and
 * the advanced cursors are persisted, or nothing is.
 */
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "sql.js";
import { revalidate } from "@/lib/revalidate";

import { readDb, withDb, type BudgetDb } from "@/lib/db/client";
import {
  accounts,
  categories,
  recurringTransactions,
  recurrenceFrequencies,
  transactions,
  type RecurringTransaction,
  type Transaction,
} from "@/lib/db/schema";
import { syncCashAssetWithin } from "@/lib/db/sync-cash";
import { fromDateKey, isDateKey, toDateKey, todayKey, type DateKey } from "@/lib/dates";
import {
  nextOccurrenceAfter,
  occurrencesThrough,
  type Frequency,
  type RecurrenceRule,
} from "@/lib/recurrence";
import { parseAmount, type Cents } from "@/lib/money";
import { categoryCashDirection, normalizeLedgerCurrency } from "@/lib/cash-balance";
import type { TransactionDirection } from "@/lib/db/schema";
import {
  buildProjectedTransactionMovements,
  buildTransactionProjection,
  correctLedgerEventInput,
  postLedgerEventRaw,
} from "@/lib/ledger";

export type ActionResult<T> = { success: true; data: T } | { error: string };

/** What `generateDueTransactions` did, per template and in total. */
export type GenerationReport = {
  /** The day generation ran through, inclusive. */
  throughKey: DateKey;
  /** Transactions actually inserted. */
  posted: number;
  /** Due occurrences that were already on the ledger (a repeat run). */
  skipped: number;
  templates: Array<{
    id: number;
    name: string;
    posted: DateKey[];
    skipped: DateKey[];
    lastGenerated: DateKey | null;
    nextDue: DateKey | null;
    /** Set when this template was skipped entirely, with the reason. */
    error?: string;
  }>;
};

function str(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function num(formData: FormData, key: string): number | null {
  const value = str(formData, key);
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${key}: ${value}`);
  return parsed;
}

function parseFrequency(value: string | null): Frequency {
  if (!value || !(recurrenceFrequencies as readonly string[]).includes(value)) {
    throw new Error(
      `Invalid frequency: ${String(value)}. Expected one of ${recurrenceFrequencies.join(", ")}`,
    );
  }
  return value as Frequency;
}

function requireDateKey(value: string | null, label: string): DateKey {
  if (!isDateKey(value)) {
    throw new Error(`Invalid ${label}: expected 'YYYY-MM-DD', received ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalDateKey(value: string | null, label: string): DateKey | null {
  if (value === null) return null;
  return requireDateKey(value, label);
}

function requireMagnitude(cents: Cents): Cents {
  if (cents < 0) throw new Error("A recurring amount cannot be negative");
  return cents;
}

function recurringMovements(raw: Database, row: Transaction) {
  return buildProjectedTransactionMovements(raw, row);
}

/** DECISION: DEC-011 — templates stay mutable; only confirmed occurrences post events. */
function postRecurringProjection(raw: Database, row: Transaction, templateName: string): void {
  const movements = recurringMovements(raw, row);
  const event = postLedgerEventRaw(raw, {
    effectiveDate: row.recurringOccurrence!,
    description: row.comment ?? templateName,
    metadata: {
      projectionKey: row.id,
      transaction: buildTransactionProjection(row),
      provenance: {
        source: "recurring-occurrence",
        templateId: row.recurringId!,
        occurrence: row.recurringOccurrence!,
      },
    },
    movements,
    recordedAt: row.updatedAt,
  });
  raw.run("UPDATE transactions SET current_event_id = ? WHERE id = ?", [event.eventId, row.id]);
}

function detachRecurringProjection(raw: Database, row: Transaction, templateName: string): void {
  if (!row.currentEventId) throw new Error("A confirmed recurring occurrence has no ledger event");
  const movements = recurringMovements(raw, row);
  const input = correctLedgerEventInput(row.currentEventId, movements, movements, {
    effectiveDate: toDateKey(row.date),
    description: row.comment ?? templateName,
    metadata: {
      projectionKey: row.id,
      transaction: buildTransactionProjection(row, [], { recurringId: null }),
      provenance: {
        source: "recurring-template-detach",
        templateId: row.recurringId!,
        occurrence: row.recurringOccurrence!,
      },
    },
    recordedAt: new Date(),
  });
  const event = postLedgerEventRaw(raw, input);
  raw.run(
    "UPDATE transactions SET recurring_id = NULL, current_event_id = ? WHERE id = ?",
    [event.eventId, row.id],
  );
}

async function assertTemplateTransferCurrency(
  db: BudgetDb,
  accountId: number | null,
  transferAccountId: number | null,
): Promise<void> {
  if (transferAccountId === null) return;
  if (accountId === null) throw new Error("A transfer needs a source account");
  const rows = await db.select().from(accounts);
  const source = rows.find((account) => account.id === accountId);
  const destination = rows.find((account) => account.id === transferAccountId);
  if (!source) throw new Error(`No account with id ${accountId}`);
  if (!destination) throw new Error(`No account with id ${transferAccountId}`);
  const sourceCurrency = normalizeLedgerCurrency(source.currency);
  const destinationCurrency = normalizeLedgerCurrency(destination.currency);
  if (sourceCurrency !== destinationCurrency) {
    throw new Error(
      `Cannot transfer between ${sourceCurrency} and ${destinationCurrency} accounts without an FX model.`,
    );
  }
}

/** The recurrence rule of a stored template. */
function ruleOf(template: RecurringTransaction): RecurrenceRule {
  return {
    frequency: template.frequency,
    interval: template.interval,
    startDate: template.startDate,
    endDate: template.endDate,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Every template, oldest first. Archived templates are excluded by default. */
export async function getRecurringTransactions(options?: {
  includeArchived?: boolean;
}): Promise<RecurringTransaction[]> {
  const includeArchived = options?.includeArchived === true;
  return readDb((db) => {
    const query = db.select().from(recurringTransactions);
    return includeArchived
      ? query.orderBy(asc(recurringTransactions.id))
      : query
          .where(eq(recurringTransactions.archived, false))
          .orderBy(asc(recurringTransactions.id));
  });
}

/**
 * What each active template will post between now and `throughKey`, WITHOUT
 * writing anything. This is the preview a "Due soon" panel renders, and it is
 * also how a caller can see what `generateDueTransactions` is about to do.
 */
export async function getUpcomingRecurring(options?: { throughKey?: DateKey }) {
  const throughKey = options?.throughKey ?? todayKey();
  if (!isDateKey(throughKey)) throw new Error(`Invalid throughKey: ${String(throughKey)}`);

  const templates = await getRecurringTransactions();
  return templates.map((template) => {
    let due: DateKey[] = [];
    let error: string | undefined;
    try {
      due = occurrencesThrough(ruleOf(template), throughKey, {
        afterKey: template.lastGenerated,
      });
    } catch (cause) {
      error = (cause as Error).message;
    }
    return {
      id: template.id,
      name: template.name,
      amountCents: template.amountCents,
      accountId: template.accountId,
      transferAccountId: template.transferAccountId,
      categoryId: template.categoryId,
      frequency: template.frequency,
      interval: template.interval,
      nextDue: template.nextDue,
      lastGenerated: template.lastGenerated,
      due,
      ...(error ? { error } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Create a template.
 *
 * Fields: name, amount, frequency, startDate ('YYYY-MM-DD'), interval,
 * accountId, transferAccountId (makes each occurrence a transfer), categoryId,
 * comment, endDate.
 *
 * `next_due` is computed here so the "what is coming up" query never has to
 * re-derive it.
 */
export async function createRecurringTransaction(
  formData: FormData,
): Promise<ActionResult<RecurringTransaction>> {
  try {
    const name = str(formData, "name");
    if (!name) return { error: "A recurring transaction needs a name" };

    const frequency = parseFrequency(str(formData, "frequency"));
    const startDate = requireDateKey(str(formData, "startDate") ?? todayKey(), "startDate");
    const endDate = optionalDateKey(str(formData, "endDate"), "endDate");
    const interval = num(formData, "interval") ?? 1;
    if (!Number.isInteger(interval) || interval < 1) {
      return { error: "Interval must be a whole number of 1 or more" };
    }
    if (endDate !== null && endDate < startDate) {
      return { error: "The end date cannot be before the start date" };
    }

    const amountCents = requireMagnitude(parseAmount(str(formData, "amount") ?? ""));
    const accountId = num(formData, "accountId");
    const transferAccountId = num(formData, "transferAccountId");
    const categoryId = num(formData, "categoryId");

    if (transferAccountId !== null && transferAccountId === accountId) {
      return { error: "A transfer must move money between two DIFFERENT accounts" };
    }
    if (transferAccountId !== null && categoryId !== null) {
      return { error: "A transfer has no category" };
    }

    const rule: RecurrenceRule = { frequency, interval, startDate, endDate };
    const nextDue = nextOccurrenceAfter(rule, null);

    const template = await withDb(async (db) => {
      await assertTemplateTransferCurrency(db, accountId, transferAccountId);
      const [row] = await db
        .insert(recurringTransactions)
        .values({
          name,
          accountId,
          transferAccountId,
          categoryId,
          amountCents,
          comment: str(formData, "comment"),
          frequency,
          interval,
          startDate,
          endDate,
          nextDue,
          lastGenerated: null,
          archived: formData.get("archived") === "true",
        })
        .returning();
      return row;
    });

    revalidate("/transactions", "/recurring", "/");
    return { success: true, data: template };
  } catch (error) {
    console.error("Failed to create recurring transaction:", error);
    return { error: (error as Error).message || "Failed to create recurring transaction" };
  }
}

/**
 * Update a template. Only the fields present in `formData` change.
 *
 * Changing the rule recomputes `next_due` from `last_generated`, so an edit never
 * re-posts an occurrence that has already been materialised.
 */
export async function updateRecurringTransaction(
  id: number,
  formData: FormData,
): Promise<ActionResult<RecurringTransaction>> {
  try {
    const template = await withDb(async (db) => {
      const [existing] = await db
        .select()
        .from(recurringTransactions)
        .where(eq(recurringTransactions.id, id));
      if (!existing) throw new Error(`No recurring transaction with id ${id}`);

      const frequency = formData.has("frequency")
        ? parseFrequency(str(formData, "frequency"))
        : existing.frequency;
      const startDate = formData.has("startDate")
        ? requireDateKey(str(formData, "startDate"), "startDate")
        : existing.startDate;
      const endDate = formData.has("endDate")
        ? optionalDateKey(str(formData, "endDate"), "endDate")
        : existing.endDate;
      const interval = formData.has("interval") ? (num(formData, "interval") ?? 1) : existing.interval;
      if (!Number.isInteger(interval) || interval < 1) {
        throw new Error("Interval must be a whole number of 1 or more");
      }
      if (endDate !== null && endDate < startDate) {
        throw new Error("The end date cannot be before the start date");
      }

      const accountId = formData.has("accountId") ? num(formData, "accountId") : existing.accountId;
      const transferAccountId = formData.has("transferAccountId")
        ? num(formData, "transferAccountId")
        : existing.transferAccountId;
      const categoryId = formData.has("categoryId") ? num(formData, "categoryId") : existing.categoryId;
      if (transferAccountId !== null && transferAccountId === accountId) {
        throw new Error("A transfer must move money between two DIFFERENT accounts");
      }
      if (transferAccountId !== null && categoryId !== null) {
        throw new Error("A transfer has no category");
      }
      await assertTemplateTransferCurrency(db, accountId, transferAccountId);

      const amountRaw = str(formData, "amount");
      const rule: RecurrenceRule = { frequency, interval, startDate, endDate };

      const [row] = await db
        .update(recurringTransactions)
        .set({
          name: str(formData, "name") ?? existing.name,
          accountId,
          transferAccountId,
          categoryId,
          amountCents: amountRaw === null ? existing.amountCents : requireMagnitude(parseAmount(amountRaw)),
          comment: formData.has("comment") ? str(formData, "comment") : existing.comment,
          frequency,
          interval,
          startDate,
          endDate,
          // Recomputed, never carried over blindly: the rule may have moved.
          nextDue: nextOccurrenceAfter(rule, existing.lastGenerated),
          archived: formData.has("archived")
            ? formData.get("archived") === "true"
            : existing.archived,
          updatedAt: new Date(),
        })
        .where(eq(recurringTransactions.id, id))
        .returning();
      return row;
    });

    revalidate("/transactions", "/recurring", "/");
    return { success: true, data: template };
  } catch (error) {
    console.error("Failed to update recurring transaction:", error);
    return { error: (error as Error).message || "Failed to update recurring transaction" };
  }
}

/** Pause or resume a template. Paused templates generate nothing. */
export async function setRecurringArchived(
  id: number,
  archived: boolean,
): Promise<ActionResult<RecurringTransaction>> {
  try {
    const template = await withDb(async (db) => {
      const [row] = await db
        .update(recurringTransactions)
        .set({ archived, updatedAt: new Date() })
        .where(eq(recurringTransactions.id, id))
        .returning();
      if (!row) throw new Error(`No recurring transaction with id ${id}`);
      return row;
    });
    revalidate("/transactions", "/recurring");
    return { success: true, data: template };
  } catch (error) {
    console.error("Failed to archive recurring transaction:", error);
    return { error: (error as Error).message || "Failed to archive recurring transaction" };
  }
}

/**
 * Delete a template. Transactions it already generated are KEPT — their
 * `recurring_id` is set to NULL by the foreign key — because they are real
 * spending that happened.
 */
export async function deleteRecurringTransaction(id: number): Promise<ActionResult<{ id: number }>> {
  try {
    await withDb(async (db, raw) => {
      const [template] = await db
        .select()
        .from(recurringTransactions)
        .where(eq(recurringTransactions.id, id));
      if (!template) throw new Error(`No recurring transaction with id ${id}`);
      const materialized = await db
        .select()
        .from(transactions)
        .where(eq(transactions.recurringId, id));
      for (const row of materialized) detachRecurringProjection(raw, row, template.name);
      await db.delete(recurringTransactions).where(eq(recurringTransactions.id, id));
    });
    revalidate("/transactions", "/recurring", "/");
    return { success: true, data: { id } };
  } catch (error) {
    console.error("Failed to delete recurring transaction:", error);
    return { error: (error as Error).message || "Failed to delete recurring transaction" };
  }
}

/**
 * Materialise every occurrence that is due on or before `throughKey` (today by
 * default) into real transactions.
 *
 * IDEMPOTENT: running it twice in one day posts nothing the second time. Catch-up
 * across several missed months posts each missed occurrence exactly once, on its
 * own calendar day — not all lumped onto today.
 *
 * A template with an unusable rule is reported in `templates[].error` and skipped;
 * one bad template never blocks the others.
 */
export async function generateDueTransactions(options?: {
  throughKey?: DateKey;
}): Promise<ActionResult<GenerationReport>> {
  try {
    const throughKey = options?.throughKey ?? todayKey();
    if (!isDateKey(throughKey)) throw new Error(`Invalid throughKey: ${String(throughKey)}`);

    const report = await withDb(async (db, raw) => {
      const templates = await db
        .select()
        .from(recurringTransactions)
        .where(eq(recurringTransactions.archived, false))
        .orderBy(asc(recurringTransactions.id));
      const accountRows = await db.select().from(accounts);
      const categoryRows = await db.select().from(categories);
      const accountById = new Map(accountRows.map((account) => [account.id, account]));
      const categoryById = new Map(categoryRows.map((category) => [category.id, category]));

      const result: GenerationReport = { throughKey, posted: 0, skipped: 0, templates: [] };

      for (const template of templates) {
        const entry: GenerationReport["templates"][number] = {
          id: template.id,
          name: template.name,
          posted: [],
          skipped: [],
          lastGenerated: template.lastGenerated,
          nextDue: template.nextDue,
        };

        let due: DateKey[];
        let direction: TransactionDirection;
        let currency: string;
        try {
          if (template.amountCents < 0) throw new Error("Recurring amount cannot be negative");
          if (template.transferAccountId !== null) {
            if (template.accountId === null) throw new Error("Transfer template has no source account");
            const source = accountById.get(template.accountId);
            const destination = accountById.get(template.transferAccountId);
            if (!source || !destination) throw new Error("Transfer template references a missing account");
            currency = normalizeLedgerCurrency(source.currency);
            const destinationCurrency = normalizeLedgerCurrency(destination.currency);
            if (currency !== destinationCurrency) {
              throw new Error(
                `Cannot transfer between ${currency} and ${destinationCurrency} accounts without an FX model.`,
              );
            }
            direction = "transfer";
          } else {
            const category =
              template.categoryId === null ? undefined : categoryById.get(template.categoryId);
            const resolved = categoryCashDirection(category?.type);
            if (resolved !== "inflow" && resolved !== "outflow") {
              throw new Error("Non-transfer template references no directional category");
            }
            direction = resolved;
            if (template.accountId === null) {
              currency = "USD";
            } else {
              const account = accountById.get(template.accountId);
              if (!account) throw new Error(`Template references missing account ${template.accountId}`);
              currency = normalizeLedgerCurrency(account.currency);
            }
          }
          due = occurrencesThrough(ruleOf(template), throughKey, {
            afterKey: template.lastGenerated,
          });
        } catch (cause) {
          entry.error = (cause as Error).message;
          result.templates.push(entry);
          continue;
        }

        for (const occurrence of due) {
          // Belt to the partial UNIQUE index's braces: report a repeat run as
          // "skipped" rather than letting it raise a constraint error.
          const existing = await db
            .select({ id: transactions.id })
            .from(transactions)
            .where(
              and(
                eq(transactions.recurringId, template.id),
                eq(transactions.recurringOccurrence, occurrence),
              ),
            );
          if (existing.length > 0) {
            entry.skipped.push(occurrence);
            result.skipped++;
            continue;
          }

          const [projected] = await db.insert(transactions).values({
            // Local midnight of the occurrence day: the row belongs to the day it
            // is due, so it lands in the right budget period.
            date: fromDateKey(occurrence),
            categoryId: template.categoryId,
            accountId: template.accountId,
            transferAccountId: template.transferAccountId,
            amountCents: template.amountCents,
            direction,
            currency,
            comment: template.comment,
            pending: false,
            recurringId: template.id,
            recurringOccurrence: occurrence,
          }).returning();
          postRecurringProjection(raw, projected, template.name);
          entry.posted.push(occurrence);
          result.posted++;
        }

        // The cursor advances over everything that is now on the ledger, whether
        // this run posted it or a previous one did.
        //
        // Take the MAXIMUM rather than the last element: `posted` and `skipped`
        // are each ascending, but concatenating them is not sorted in general, so
        // indexing the tail could move the cursor BACKWARDS and re-post an
        // occurrence. In practice a re-run skips a prefix and posts a suffix, so
        // the tail happens to be correct — this makes it true by construction.
        const settled = [...entry.posted, ...entry.skipped];
        const lastGenerated = settled.length
          ? settled.reduce((max, key) => (key > max ? key : max))
          : template.lastGenerated;
        const nextDue = nextOccurrenceAfter(ruleOf(template), lastGenerated);

        if (lastGenerated !== template.lastGenerated || nextDue !== template.nextDue) {
          await db
            .update(recurringTransactions)
            .set({ lastGenerated, nextDue, updatedAt: new Date() })
            .where(eq(recurringTransactions.id, template.id));
        }

        entry.lastGenerated = lastGenerated;
        entry.nextDue = nextDue;
        result.templates.push(entry);
      }

      // The derived Cash asset must not drift behind the rows we just posted.
      if (result.posted > 0) await syncCashAssetWithin(db);

      return result;
    });

    if (report.posted > 0) {
      revalidate("/transactions", "/recurring", "/");
    }
    return { success: true, data: report };
  } catch (error) {
    console.error("Failed to generate recurring transactions:", error);
    return { error: (error as Error).message || "Failed to generate recurring transactions" };
  }
}

/**
 * Names of the accounts and categories a template can point at — a convenience
 * for building the template form without a second round trip.
 */
export async function getRecurringFormOptions() {
  return readDb(async (db) => ({
    accounts: await db
      .select({ id: accounts.id, name: accounts.name, kind: accounts.kind, type: accounts.type })
      .from(accounts)
      .where(eq(accounts.archived, false))
      .orderBy(asc(accounts.id)),
    categories: await db
      .select({ id: categories.id, name: categories.name, type: categories.type })
      .from(categories)
      .orderBy(asc(categories.name)),
  }));
}
