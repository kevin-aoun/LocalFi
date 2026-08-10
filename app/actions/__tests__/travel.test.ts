import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addTravelCity,
  deleteTravelCity,
  getTravelCities,
  setTravelCityOrigin,
} from "@/app/actions/travel";

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
      new Response(JSON.stringify([{ lat: "43.6532", lon: "-79.3832" }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const created = await addTravelCity(cityForm("Toronto", "CAN"));
    expect(created).toMatchObject({
      success: true,
      data: {
        countryCode: "CAN",
        countryName: "Canada",
        cityName: "Toronto",
        latitude: 43.6532,
        longitude: -79.3832,
      },
    });
    expect(temp.scalar("SELECT COUNT(*) FROM visited_countries")).toBe(1);
    expect(await getTravelCities()).toEqual([created.data]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("city")).toBe("Toronto");
    expect(url.searchParams.get("countrycodes")).toBe("ca");

    expect(await addTravelCity(cityForm("toronto", "CAN"))).toMatchObject({
      error: expect.stringMatching(/already/i),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("removes the internal country record when its last city is deleted", async () => {
    execOn(temp, (db) => {
      db.run("INSERT INTO visited_countries (country_code, country_name) VALUES ('CAN', 'Canada')");
      db.run(
        "INSERT INTO travel_checkpoints (id, country_code, city_name, latitude, longitude) VALUES (7, 'CAN', 'Vancouver', 49.28, -123.12)",
      );
    });

    expect(await deleteTravelCity(7)).toEqual({ success: true });
    expect(await getTravelCities()).toEqual([]);
    expect(temp.scalar("SELECT COUNT(*) FROM visited_countries")).toBe(0);
  });

  it("keeps the country while another city still belongs to it", async () => {
    execOn(temp, (db) => {
      db.run("INSERT INTO visited_countries (country_code, country_name) VALUES ('CAN', 'Canada')");
      db.run(
        "INSERT INTO travel_checkpoints (id, country_code, city_name, latitude, longitude) VALUES (7, 'CAN', 'Toronto', 43.65, -79.38), (8, 'CAN', 'Vancouver', 49.28, -123.12)",
      );
    });

    expect(await deleteTravelCity(7)).toEqual({ success: true });
    expect((await getTravelCities()).map((city) => city.cityName)).toEqual(["Vancouver"]);
    expect(temp.scalar("SELECT COUNT(*) FROM visited_countries")).toBe(1);
  });

  it("stores an explicit origin per city and clears routes when that origin is deleted", async () => {
    execOn(temp, (db) => {
      db.run(
        "INSERT INTO visited_countries (country_code, country_name) VALUES ('ESP', 'Spain'), ('FRA', 'France')",
      );
      db.run(
        "INSERT INTO travel_checkpoints (id, country_code, city_name, latitude, longitude) VALUES (1, 'ESP', 'Madrid', 40.42, -3.70), (2, 'FRA', 'Lyon', 45.76, 4.84)",
      );
    });

    expect(await setTravelCityOrigin(2, 1)).toMatchObject({
      success: true,
      data: { id: 2, originCityId: 1 },
    });
    expect((await getTravelCities()).find((city) => city.id === 2)?.originCityId).toBe(1);

    expect(await deleteTravelCity(1)).toEqual({ success: true });
    expect((await getTravelCities()).find((city) => city.id === 2)?.originCityId).toBeNull();
  });
});
