"use client";

import { useState } from "react";
import { Globe2, Map as MapIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Map,
  MapArc,
  MapControls,
  MapGeoJSON,
  MapMarker,
  MarkerContent,
  MarkerLabel,
} from "@/components/ui/map";
import type { TravelCity } from "@/lib/db/schema";

const WORLD_GEOJSON =
  "/maps/natural-earth-countries-110m-v5.1.2.geojson";

type MapView = "flat" | "globe";

export default function TravelMap({ cities }: { cities: readonly TravelCity[] }) {
  const [view, setView] = useState<MapView>("globe");
  const firstCity = cities[0];
  const center: [number, number] = firstCity
    ? [firstCity.longitude, firstCity.latitude]
    : [15, 25];
  const citiesById = new globalThis.Map(cities.map((city) => [city.id, city]));
  const arcs = cities.flatMap((city) => {
    const origin = city.originCityId === null ? null : citiesById.get(city.originCityId);
    if (!origin) return [];
    return [
      {
        id: city.id,
        from: [origin.longitude, origin.latitude] as [number, number],
        to: [city.longitude, city.latitude] as [number, number],
      },
    ];
  });

  return (
    <div className="relative h-full min-h-0 w-full">
      <Map
        key={`${view}-${firstCity?.id ?? "empty"}`}
        blank={view === "globe"}
        center={center}
        zoom={view === "globe" ? 1.75 : 1.8}
        projection={{ type: view === "globe" ? "globe" : "mercator" }}
        className="h-full w-full"
      >
        {view === "globe" && (
          <MapGeoJSON
            id="world-countries"
            data={WORLD_GEOJSON}
            interactive={false}
          />
        )}

        {arcs.length > 0 && (
          <MapArc
            id="travel-arcs"
            data={arcs}
            paint={{
              "line-color": "#3b82f6",
              "line-width": 2,
              "line-opacity": 0.9,
              "line-dasharray": [2, 2],
            }}
            interactive={false}
          />
        )}

        {cities.map((city, index) => (
          <MapMarker
            key={city.id}
            longitude={city.longitude}
            latitude={city.latitude}
            opacityWhenCovered="1"
          >
            <MarkerContent>
              <div className="size-2.5 rounded-full border-2 border-background bg-blue-500 ring-1 ring-blue-600" />
              <MarkerLabel
                position={index % 2 === 0 ? "top" : "bottom"}
                className="rounded-sm border border-border bg-background px-1.5 py-0.5 text-[11px] font-semibold text-foreground shadow-sm"
              >
                {city.cityName}
              </MarkerLabel>
            </MarkerContent>
          </MapMarker>
        ))}

        <MapControls position="top-right" showCompass showZoom />
      </Map>

      <div
        className="absolute left-3 top-3 z-10 flex rounded-lg border bg-background/90 p-1 backdrop-blur"
        role="group"
        aria-label="Map view"
      >
        <Button
          type="button"
          size="sm"
          variant={view === "flat" ? "secondary" : "ghost"}
          className="h-8 gap-1.5 px-2.5"
          aria-pressed={view === "flat"}
          onClick={() => setView("flat")}
        >
          <MapIcon className="size-4" />
          Flat
        </Button>
        <Button
          type="button"
          size="sm"
          variant={view === "globe" ? "secondary" : "ghost"}
          className="h-8 gap-1.5 px-2.5"
          aria-pressed={view === "globe"}
          onClick={() => setView("globe")}
        >
          <Globe2 className="size-4" />
          Globe
        </Button>
      </div>
    </div>
  );
}
