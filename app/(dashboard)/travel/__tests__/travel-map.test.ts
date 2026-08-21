import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..", "..", "..", "..");
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

describe("travel map", () => {
  it("uses mapcn's globe, offline world geography, arcs, and city markers", () => {
    const source = read("app/(dashboard)/travel/travel-map.tsx");
    expect(source).toMatch(/blank=\{view === "globe"\}/);
    expect(source).toMatch(/<MapGeoJSON/);
    expect(source).toMatch(/<MapArc/);
    expect(source).toMatch(/<MapMarker/);
    expect(source).toMatch(/<MarkerLabel/);
    expect(source).toMatch(/"line-dasharray": \[2, 2\]/);
    expect(source).toContain('"/maps/natural-earth-countries-110m-v5.1.2.geojson"');
    expect(source).not.toMatch(/https?:\/\/|cdn\.jsdelivr/i);
  });

  it("vendors the pinned Natural Earth country polygons with attribution", () => {
    const geographyPath = path.join(
      root,
      "public/maps/natural-earth-countries-110m-v5.1.2.geojson",
    );
    const geographyBytes = readFileSync(geographyPath);
    const geography = JSON.parse(geographyBytes.toString("utf8")) as {
      type?: string;
      features?: Array<{ geometry?: { type?: string } }>;
    };
    const attribution = read("public/maps/README.md");

    expect(geography.type).toBe("FeatureCollection");
    expect(geography.features).toHaveLength(177);
    expect(
      geography.features?.every(({ geometry }) =>
        geometry?.type === "Polygon" || geometry?.type === "MultiPolygon"),
    ).toBe(true);
    expect(attribution).toMatch(/Natural Earth 1:110m/);
    expect(attribution).toMatch(/public domain/i);
    expect(attribution).toContain("v5.1.2");
    expect(createHash("sha256").update(geographyBytes).digest("hex")).toBe(
      "6866c877d39cba9c357620878839b336d569f8c662d3cfab4cb1dbe2d39c977f",
    );
  });

  it("declutters dense itineraries without showing markers through the globe", () => {
    const source = read("app/(dashboard)/travel/travel-map.tsx");
    expect(source).toMatch(/cities\.map\(\(city, index\)/);
    expect(source).toContain('opacityWhenCovered="0"');
    expect(source).toMatch(/cityLabelPresentations\(cities\.length\)/);
    expect(source).toContain("position={labels[index].position}");
    expect(source).toMatch(/border-border bg-background[\s\S]*text-foreground shadow-sm/);
    expect(source).not.toMatch(/bg-background\/80/);
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

  it("groups unnumbered city rows inside collapsed country disclosures", () => {
    const page = read("app/(dashboard)/travel/page.tsx");
    expect(page).toMatch(/addTravelCity/);
    expect(page).toMatch(/Add city/);
    expect(page).toMatch(/groupCitiesByCountry/);
    expect(page).toMatch(/countryGroupPresentation/);
    expect(page).toMatch(/presentation\.cityName/);
    expect(page).toMatch(/presentation\.countLabel/);
    expect(page).toMatch(/group\.cities\.map/);
    expect(page).toMatch(/<details[\s\S]*<summary/);
    expect(page).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
    expect(page).toMatch(/group-open\/country:rotate-90/);
    expect(page).not.toMatch(/index \+ 1|>Hub</);
    expect(page).not.toMatch(/toggleCountry|getVisitedCountries|Add a country/);
    expect(page).toMatch(/flex h-full[\s\S]*flex-col/);
    expect(page).toMatch(/grid min-h-0 flex-1/);
    expect(page).not.toMatch(/h-\[500px\]/);
  });
});
