import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const visitedCountries = sqliteTable("visited_countries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  countryCode: text("country_code").notNull().unique(), // ISO 3166-1 alpha-3
  countryName: text("country_name").notNull(),
  visitedAt: text("visited_at").default(sql`(current_timestamp)`),
});

export type VisitedCountry = typeof visitedCountries.$inferSelect;
