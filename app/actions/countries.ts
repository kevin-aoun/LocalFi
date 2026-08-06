"use server";

import { readDb, withDb } from "@/lib/db/client";
import { visitedCountries } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { revalidate } from "@/lib/revalidate";

export async function getVisitedCountries() {
  return readDb((db) => db.select().from(visitedCountries));
}

/**
 * Add or remove a visited country.
 *
 * Runs inside ONE `withDb` call so the read-then-write is not interleaved with
 * another writer, and so a throw discards the change instead of leaving it in the
 * shared in-memory image for some later action's flush to persist.
 *
 * Revalidation goes through the `lib/revalidate` wrapper, not `revalidatePath`
 * directly: the bare call throws when there is no request scope (a script, a
 * test), and because it sat inside the `try`, that turned a SUCCESSFUL write into
 * a reported failure.
 */
export async function toggleCountry(countryCode: string, countryName: string) {
  try {
    const result = await withDb(async (db) => {
      const existing = await db
        .select()
        .from(visitedCountries)
        .where(eq(visitedCountries.countryCode, countryCode));

      if (existing.length > 0) {
        await db.delete(visitedCountries).where(eq(visitedCountries.countryCode, countryCode));
        return { success: true as const, action: "removed" as const };
      }

      const [country] = await db
        .insert(visitedCountries)
        .values({ countryCode, countryName })
        .returning();
      return { success: true as const, action: "added" as const, data: country };
    });

    revalidate("/travel");
    return result;
  } catch (error) {
    console.error("Failed to toggle country:", error);
    return { error: "Failed to toggle country" };
  }
}
