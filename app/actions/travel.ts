"use server";

import { asc, eq } from "drizzle-orm";

import { COUNTRIES_BY_ALPHA3 } from "@/lib/countries";
import { readDb, withDb } from "@/lib/db/client";
import { travelCities, visitedCountries, type TravelCity } from "@/lib/db/schema";
import { revalidate } from "@/lib/revalidate";

const NOMINATIM_URL = process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org";
const NOMINATIM_USER_AGENT =
  process.env.NOMINATIM_USER_AGENT ?? "LocalFi/0.1 (self-hosted personal finance app)";

type NominatimResult = { lat?: unknown; lon?: unknown };

let geocodeQueue: Promise<void> = Promise.resolve();
let lastGeocodeAt = 0;

function requireFormValue(formData: FormData, key: string) {
  const value = formData.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value.trim();
}

function sameCityName(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

async function geocodeCity(cityName: string, countryAlpha2: string) {
  const request = geocodeQueue.then(async () => {
    const waitMs = Math.max(0, 1_000 - (Date.now() - lastGeocodeAt));
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
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

    const [result] = (await response.json()) as NominatimResult[];
    const latitude = Number(result?.lat);
    const longitude = Number(result?.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error(`Could not find ${cityName} in that country.`);
    }
    return { latitude, longitude };
  });

  geocodeQueue = request.then(
    () => undefined,
    () => undefined,
  );
  return request;
}

export async function getTravelCities(): Promise<TravelCity[]> {
  return readDb((db) =>
    db
      .select({
        id: travelCities.id,
        countryCode: travelCities.countryCode,
        countryName: visitedCountries.countryName,
        cityName: travelCities.cityName,
        latitude: travelCities.latitude,
        longitude: travelCities.longitude,
        visitedAt: travelCities.visitedAt,
      })
      .from(travelCities)
      .innerJoin(visitedCountries, eq(travelCities.countryCode, visitedCountries.countryCode))
      .orderBy(asc(travelCities.visitedAt), asc(travelCities.id)),
  );
}

export async function addTravelCity(formData: FormData) {
  try {
    const countryCode = requireFormValue(formData, "countryCode").toUpperCase();
    const cityName = requireFormValue(formData, "cityName");
    if (cityName.length > 100) return { error: "City names must be 100 characters or fewer." };

    const country = COUNTRIES_BY_ALPHA3.get(countryCode);
    if (!country) return { error: "Choose a valid country." };

    const existing = await readDb((db) =>
      db
        .select({ cityName: travelCities.cityName })
        .from(travelCities)
        .where(eq(travelCities.countryCode, countryCode)),
    );
    if (existing.some((city) => sameCityName(city.cityName, cityName))) {
      return { error: `${cityName} is already in your itinerary.` };
    }

    const coordinates = await geocodeCity(cityName, country.alpha2);
    const city = await withDb(async (db) => {
      await db
        .insert(visitedCountries)
        .values({ countryCode, countryName: country.name })
        .onConflictDoUpdate({
          target: visitedCountries.countryCode,
          set: { countryName: country.name },
        });

      const duplicates = await db
        .select({ cityName: travelCities.cityName })
        .from(travelCities)
        .where(eq(travelCities.countryCode, countryCode));
      if (duplicates.some((item) => sameCityName(item.cityName, cityName))) {
        throw new Error("DUPLICATE_TRAVEL_CITY");
      }

      const [created] = await db
        .insert(travelCities)
        .values({ countryCode, cityName, ...coordinates })
        .returning();
      return { ...created, countryName: country.name } satisfies TravelCity;
    });

    revalidate("/travel");
    return { success: true as const, data: city };
  } catch (error) {
    console.error("Failed to add travel city:", error);
    const message = error instanceof Error ? error.message : "Failed to add city.";
    return {
      error: /DUPLICATE_TRAVEL_CITY|UNIQUE constraint failed/i.test(message)
        ? "That city is already in your itinerary."
        : message,
    };
  }
}

export async function deleteTravelCity(id: number) {
  try {
    if (!Number.isInteger(id) || id <= 0) return { error: "Invalid city." };

    const deleted = await withDb(async (db) => {
      const [city] = await db
        .delete(travelCities)
        .where(eq(travelCities.id, id))
        .returning({ id: travelCities.id, countryCode: travelCities.countryCode });
      if (!city) return null;

      const [remaining] = await db
        .select({ id: travelCities.id })
        .from(travelCities)
        .where(eq(travelCities.countryCode, city.countryCode))
        .limit(1);
      if (!remaining) {
        await db
          .delete(visitedCountries)
          .where(eq(visitedCountries.countryCode, city.countryCode));
      }
      return city;
    });

    if (!deleted) return { error: "City not found." };
    revalidate("/travel");
    return { success: true as const };
  } catch (error) {
    console.error("Failed to delete travel city:", error);
    return { error: "Failed to delete city." };
  }
}
