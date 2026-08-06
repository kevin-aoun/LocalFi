"use server";

import { readDb, withDb } from "@/lib/db/client";
import { travelCheckpoints, visitedCountries } from "@/lib/db/schema";
import { COUNTRIES_BY_ALPHA3 } from "@/lib/countries";
import { asc, eq } from "drizzle-orm";
import { revalidate } from "@/lib/revalidate";

const NOMINATIM_URL = process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org";
const NOMINATIM_USER_AGENT =
  process.env.NOMINATIM_USER_AGENT ?? "LocalFi/0.1 (self-hosted personal finance app)";

type NominatimResult = { lat?: unknown; lon?: unknown };

let geocodeQueue: Promise<void> = Promise.resolve();
let lastGeocodeAt = 0;

function requiredFormString(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value.trim();
}

/** Queue explicit user searches so the public endpoint never sees autocomplete traffic. */
async function geocodeCity(cityName: string, countryAlpha2: string) {
  const run = geocodeQueue.then(async () => {
    const delay = Math.max(0, 1_000 - (Date.now() - lastGeocodeAt));
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    lastGeocodeAt = Date.now();

    const url = new URL("/search", NOMINATIM_URL);
    url.searchParams.set("city", cityName);
    url.searchParams.set("countrycodes", countryAlpha2.toLowerCase());
    url.searchParams.set("featureType", "city");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");

    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        "Accept-Language": "en",
        "User-Agent": NOMINATIM_USER_AGENT,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`City lookup failed (${response.status}). Try again.`);
    const results = (await response.json()) as NominatimResult[];
    const latitude = Number(results[0]?.lat);
    const longitude = Number(results[0]?.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error(`Could not find ${cityName} in that country.`);
    }
    return { latitude, longitude };
  });
  geocodeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function getVisitedCountries() {
  return readDb((db) => db.select().from(visitedCountries));
}

export async function getTravelCheckpoints() {
  return readDb((db) =>
    db.select().from(travelCheckpoints).orderBy(asc(travelCheckpoints.visitedAt), asc(travelCheckpoints.id)),
  );
}

export async function createTravelCheckpoint(formData: FormData) {
  try {
    const countryCode = requiredFormString(formData, "countryCode").toUpperCase();
    const cityName = requiredFormString(formData, "cityName");
    if (cityName.length > 100) return { error: "City names must be 100 characters or fewer." };

    const countryInfo = COUNTRIES_BY_ALPHA3.get(countryCode);
    if (!countryInfo) return { error: "Choose a valid country." };

    const context = await readDb(async (db) => ({
      country: (
        await db.select().from(visitedCountries).where(eq(visitedCountries.countryCode, countryCode))
      )[0],
      checkpoints: await db
        .select()
        .from(travelCheckpoints)
        .where(eq(travelCheckpoints.countryCode, countryCode)),
    }));
    if (!context.country) return { error: "Add the country to Visited before adding a city." };
    if (context.checkpoints.some((row) => row.cityName.toLocaleLowerCase() === cityName.toLocaleLowerCase())) {
      return { error: `${cityName} is already a checkpoint.` };
    }

    const coordinates = await geocodeCity(cityName, countryInfo.alpha2);
    const checkpoint = await withDb(async (db) => {
      const [country] = await db
        .select()
        .from(visitedCountries)
        .where(eq(visitedCountries.countryCode, countryCode));
      if (!country) throw new Error("That country is no longer in Visited.");
      const [created] = await db
        .insert(travelCheckpoints)
        .values({ countryCode, cityName, ...coordinates })
        .returning();
      return created;
    });

    revalidate("/travel");
    return { success: true as const, data: checkpoint };
  } catch (error) {
    console.error("Failed to create travel checkpoint:", error);
    const message = error instanceof Error ? error.message : "Failed to add city checkpoint.";
    return {
      error: /UNIQUE constraint failed/i.test(message)
        ? "That city is already a checkpoint."
        : message,
    };
  }
}

export async function deleteTravelCheckpoint(id: number) {
  try {
    if (!Number.isInteger(id) || id <= 0) return { error: "Invalid checkpoint." };
    const deleted = await withDb((db) =>
      db.delete(travelCheckpoints).where(eq(travelCheckpoints.id, id)).returning({ id: travelCheckpoints.id }),
    );
    if (deleted.length === 0) return { error: "Checkpoint not found." };
    revalidate("/travel");
    return { success: true as const };
  } catch (error) {
    console.error("Failed to delete travel checkpoint:", error);
    return { error: "Failed to delete city checkpoint." };
  }
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
