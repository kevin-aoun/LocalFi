export type TravelCountryGroup<TCity> = {
  countryCode: string;
  countryName: string;
  cities: TCity[];
};

type CountryCity = {
  countryCode: string;
  countryName: string;
};

export function groupCitiesByCountry<TCity extends CountryCity>(
  cities: readonly TCity[],
): TravelCountryGroup<TCity>[] {
  const groups = new Map<string, TravelCountryGroup<TCity>>();
  for (const city of cities) {
    const group = groups.get(city.countryCode);
    if (group) group.cities.push(city);
    else {
      groups.set(city.countryCode, {
        countryCode: city.countryCode,
        countryName: city.countryName,
        cities: [city],
      });
    }
  }
  return [...groups.values()];
}

export type CountryGroupPresentation =
  | { cityName: string; countLabel: null }
  | { cityName: null; countLabel: string };

export function countryGroupPresentation(
  cities: readonly { cityName: string }[],
): CountryGroupPresentation {
  if (cities.length === 1) {
    return { cityName: cities[0].cityName, countLabel: null };
  }
  return {
    cityName: null,
    countLabel: `${cities.length} ${cities.length === 1 ? "city" : "cities"}`,
  };
}
