import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTravelCheckpoint,
  deleteTravelCheckpoint,
  getTravelCheckpoints,
  toggleCountry,
} from "@/app/actions/countries";

import { createDomainDb, execOn, type DomainDb } from "./support/domain-fixture";

let temp: DomainDb;

beforeEach(async () => {
  temp = await createDomainDb();
  execOn(temp, (db) => {
    db.run("INSERT INTO visited_countries (country_code, country_name) VALUES ('LBN', 'Lebanon')");
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await temp.cleanup();
});

function checkpointForm(cityName: string) {
  const formData = new FormData();
  formData.set("countryCode", "LBN");
  formData.set("cityName", cityName);
  return formData;
}

describe("travel city checkpoints", () => {
  it("geocodes an explicit city submission once and stores the coordinates locally", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ lat: "33.8938", lon: "35.5018" }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const created = await createTravelCheckpoint(checkpointForm("Beirut"));
    expect(created).toMatchObject({
      success: true,
      data: { countryCode: "LBN", cityName: "Beirut", latitude: 33.8938, longitude: 35.5018 },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("city")).toBe("Beirut");
    expect(url.searchParams.get("countrycodes")).toBe("lb");

    expect(await createTravelCheckpoint(checkpointForm("beirut"))).toMatchObject({
      error: expect.stringMatching(/already/i),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("deletes a checkpoint directly", async () => {
    execOn(temp, (db) => {
      db.run(
        "INSERT INTO travel_checkpoints (id, country_code, city_name, latitude, longitude) VALUES (7, 'LBN', 'Byblos', 34.12, 35.65)",
      );
    });
    expect(await deleteTravelCheckpoint(7)).toEqual({ success: true });
    expect(await getTravelCheckpoints()).toEqual([]);
  });

  it("removing a visited country cascades to its city checkpoints", async () => {
    execOn(temp, (db) => {
      db.run(
        "INSERT INTO travel_checkpoints (country_code, city_name, latitude, longitude) VALUES ('LBN', 'Beirut', 33.89, 35.50)",
      );
    });
    expect(await toggleCountry("LBN", "Lebanon")).toMatchObject({ action: "removed" });
    expect(await getTravelCheckpoints()).toEqual([]);
  });
});
