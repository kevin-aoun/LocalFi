import { sqliteTable, integer, real, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const visitedCountries = sqliteTable("visited_countries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  countryCode: text("country_code").notNull().unique(), // ISO 3166-1 alpha-3
  countryName: text("country_name").notNull(),
  visitedAt: text("visited_at").default(sql`(current_timestamp)`),
});

export type VisitedCountry = typeof visitedCountries.$inferSelect;

export const travelCheckpoints = sqliteTable(
  "travel_checkpoints",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    countryCode: text("country_code")
      .notNull()
      .references(() => visitedCountries.countryCode, { onDelete: "cascade" }),
    cityName: text("city_name").notNull(),
    latitude: real("latitude").notNull(),
    longitude: real("longitude").notNull(),
    visitedAt: text("visited_at").notNull().default(sql`(current_timestamp)`),
  },
  (table) => ({
    countryCityUnique: uniqueIndex("travel_checkpoints_country_city_unique").on(
      table.countryCode,
      table.cityName,
    ),
  }),
);

export type TravelCheckpoint = typeof travelCheckpoints.$inferSelect;
