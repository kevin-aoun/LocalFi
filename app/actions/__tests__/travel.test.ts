import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addTravelCity, deleteTravelCity, getTravelCities } from "@/app/actions/travel";

import { createDomainDb, execOn, type DomainDb } from "./support/domain-fixture";

let temp: DomainDb;

beforeEach(async () => {
  temp = await createDomainDb();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await temp.cleanup();
});

function cityForm(cityName: string, countryCode = "LBN") {
  const formData = new FormData();
  formData.set("countryCode", countryCode);
  formData.set("cityName", cityName);
  return formData;
}

describe("travel itinerary", () => {
  it("creates the country and city together, then returns one joined itinerary row", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ lat: "33.8938", lon: "35.5018" }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const created = await addTravelCity(cityForm("Beirut"));
    expect(created).toMatchObject({
      success: true,
      data: {
        countryCode: "LBN",
        countryName: "Lebanon",
        cityName: "Beirut",
        latitude: 33.8938,
        longitude: 35.5018,
      },
    });
    expect(temp.scalar("SELECT COUNT(*) FROM visited_countries")).toBe(1);
    expect(await getTravelCities()).toEqual([created.data]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("city")).toBe("Beirut");
    expect(url.searchParams.get("countrycodes")).toBe("lb");

    expect(await addTravelCity(cityForm("beirut"))).toMatchObject({
      error: expect.stringMatching(/already/i),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("removes the internal country record when its last city is deleted", async () => {
    execOn(temp, (db) => {
      db.run("INSERT INTO visited_countries (country_code, country_name) VALUES ('LBN', 'Lebanon')");
      db.run(
        "INSERT INTO travel_checkpoints (id, country_code, city_name, latitude, longitude) VALUES (7, 'LBN', 'Byblos', 34.12, 35.65)",
      );
    });

    expect(await deleteTravelCity(7)).toEqual({ success: true });
    expect(await getTravelCities()).toEqual([]);
    expect(temp.scalar("SELECT COUNT(*) FROM visited_countries")).toBe(0);
  });

  it("keeps the country while another city still belongs to it", async () => {
    execOn(temp, (db) => {
      db.run("INSERT INTO visited_countries (country_code, country_name) VALUES ('LBN', 'Lebanon')");
      db.run(
        "INSERT INTO travel_checkpoints (id, country_code, city_name, latitude, longitude) VALUES (7, 'LBN', 'Beirut', 33.89, 35.50), (8, 'LBN', 'Byblos', 34.12, 35.65)",
      );
    });

    expect(await deleteTravelCity(7)).toEqual({ success: true });
    expect((await getTravelCities()).map((city) => city.cityName)).toEqual(["Byblos"]);
    expect(temp.scalar("SELECT COUNT(*) FROM visited_countries")).toBe(1);
  });
});
