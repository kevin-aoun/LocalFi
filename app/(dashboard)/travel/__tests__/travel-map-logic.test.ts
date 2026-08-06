import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { checkpointRouteLegs } from "../travel-map-logic";

describe("city checkpoint routes", () => {
  it("connects checkpoints in saved visit order", () => {
    const legs = checkpointRouteLegs(
      [
        { longitude: -0.1276, latitude: 51.5072 },
        { longitude: 35.5018, latitude: 33.8938 },
        { longitude: 72.8777, latitude: 19.076 },
      ],
      4,
    );

    expect(legs).toHaveLength(2);
    expect(legs[0]).toHaveLength(5);
    expect(legs[0][0][0]).toBeCloseTo(-0.1276, 8);
    expect(legs[0][0][1]).toBeCloseTo(51.5072, 8);
    expect(legs[0][4][0]).toBeCloseTo(35.5018, 8);
    expect(legs[0][4][1]).toBeCloseTo(33.8938, 8);
    expect(legs[1][0][0]).toBeCloseTo(35.5018, 8);
    expect(legs[1][0][1]).toBeCloseTo(33.8938, 8);
    expect(legs[1][4][0]).toBeCloseTo(72.8777, 8);
    expect(legs[1][4][1]).toBeCloseTo(19.076, 8);
  });

  it("returns no routes until there are two checkpoints", () => {
    expect(checkpointRouteLegs([])).toEqual([]);
    expect(checkpointRouteLegs([{ longitude: 2.35, latitude: 48.86 }])).toEqual([]);
  });

  it("rejects a sampling density that cannot describe a curve", () => {
    expect(() => checkpointRouteLegs([], 1)).toThrow(/at least 2/);
  });
});

describe("travel map wiring", () => {
  const root = path.resolve(__dirname, "..", "..", "..", "..");
  const read = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

  it("offers live flat and globe projections through mapcn", () => {
    const travelMap = read("app/(dashboard)/travel/travel-map.tsx");
    const mapcn = read("components/ui/map.tsx");
    expect(travelMap).toMatch(/"globe"\s*:\s*"mercator"/);
    expect(travelMap).toMatch(/aria-label="Map view"/);
    expect(mapcn).toMatch(/mapInstance\.setProjection\(projection\)/);
  });

  it("fills the available page height and has no fixed 500px map", () => {
    const page = read("app/(dashboard)/travel/page.tsx");
    expect(page).toMatch(/flex h-full[\s\S]*flex-col/);
    expect(page).toMatch(/grid min-h-0 flex-1/);
    expect(page).not.toMatch(/h-\[500px\]/);
  });

  it("uses the live GeoJSON ISO field and renders saved city markers", () => {
    const source = read("app/(dashboard)/travel/travel-map.tsx");
    expect(source).toMatch(/COUNTRY_CODE_PROPERTY/);
    expect(source).toMatch(/<MapMarker/);
    expect(source).toMatch(/<MarkerLabel/);
    expect(source).toMatch(/<MapRoute/);
  });
});
