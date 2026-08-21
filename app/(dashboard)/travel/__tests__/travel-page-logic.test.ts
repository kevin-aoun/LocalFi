import { describe, expect, it } from "vitest";

import {
  countryGroupPresentation,
  groupCitiesByCountry,
} from "../travel-page-logic";

type City = {
  id: number;
  countryCode: string;
  countryName: string;
  cityName: string;
};

const city = (
  id: number,
  countryCode: string,
  countryName: string,
  cityName: string,
): City => ({ id, countryCode, countryName, cityName });

describe("travel page presentation", () => {
  it("keeps country groups in first-visit order while preserving city order", () => {
    const groups = groupCitiesByCountry([
      city(1, "PRT", "Portugal", "Lisbon"),
      city(2, "USA", "United States", "New York"),
      city(3, "PRT", "Portugal", "Porto"),
      city(4, "LBN", "Lebanon", "Beirut"),
    ]);

    expect(groups.map(({ countryCode }) => countryCode)).toEqual(["PRT", "USA", "LBN"]);
    expect(groups[0].cities.map(({ cityName }) => cityName)).toEqual(["Lisbon", "Porto"]);
  });

  it("puts a single city in the collapsed country summary", () => {
    expect(countryGroupPresentation([{ cityName: "Lisbon" }])).toEqual({
      cityName: "Lisbon",
      countLabel: null,
    });
  });

  it("uses a city count for multi-city groups", () => {
    expect(
      countryGroupPresentation([{ cityName: "Lisbon" }, { cityName: "Porto" }]),
    ).toEqual({ cityName: null, countLabel: "2 cities" });
  });
});
