import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..", "..", "..", "..");
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

describe("travel map", () => {
  it("uses mapcn's globe, world geography, arcs, and city markers", () => {
    const source = read("app/(dashboard)/travel/travel-map.tsx");
    expect(source).toMatch(/blank=\{view === "globe"\}/);
    expect(source).toMatch(/<MapGeoJSON/);
    expect(source).toMatch(/<MapArc/);
    expect(source).toMatch(/<MapMarker/);
    expect(source).toMatch(/<MarkerLabel/);
    expect(source).toMatch(/"line-dasharray": \[2, 2\]/);
  });

  it("has no custom country hover or visited-country coloring", () => {
    const source = read("app/(dashboard)/travel/travel-map.tsx");
    expect(source).not.toMatch(/CountryLayers|countries-hover|countries-visited|#22c55e|useMap/);
    expect(source).not.toMatch(/MapRoute|checkpointRouteLegs/);
  });

  it("draws each route from its saved origin instead of one central hub", () => {
    const source = read("app/(dashboard)/travel/travel-map.tsx");
    expect(source).toMatch(/originCityId/);
    expect(source).toMatch(/citiesById\.get\(city\.originCityId\)/);
    expect(source).not.toMatch(/destinations|\bhub\b/i);
  });

  it("groups unnumbered city rows by country and fills the available page height", () => {
    const page = read("app/(dashboard)/travel/page.tsx");
    expect(page).toMatch(/addTravelCity/);
    expect(page).toMatch(/Add city/);
    expect(page).toMatch(/groupCitiesByCountry/);
    expect(page).toMatch(/group\.cities\.map/);
    expect(page).not.toMatch(/index \+ 1|>Hub</);
    expect(page).not.toMatch(/toggleCountry|getVisitedCountries|Add a country/);
    expect(page).toMatch(/flex h-full[\s\S]*flex-col/);
    expect(page).toMatch(/grid min-h-0 flex-1/);
    expect(page).not.toMatch(/h-\[500px\]/);
  });
});
