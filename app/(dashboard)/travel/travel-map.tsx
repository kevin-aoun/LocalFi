"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Globe2, Map as MapIcon, MapPinCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Map,
  MapControls,
  MapMarker,
  MapRoute,
  MarkerContent,
  MarkerLabel,
  MarkerTooltip,
  useMap,
  type MapRef,
} from "@/components/ui/map";
import type { TravelCheckpoint } from "@/lib/db/schema/countries";

import { checkpointRouteLegs, COUNTRY_CODE_PROPERTY } from "./travel-map-logic";

const COUNTRIES_GEOJSON_URL =
  "https://r2.datahub.io/clvyjaryy0000la0cxieg4o8o/main/raw/data/countries.geojson";

type MapView = "flat" | "globe";

function CountryLayers({ visitedCodes }: { visitedCodes: ReadonlySet<string> }) {
  const { map, isLoaded } = useMap();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!map || !isLoaded) return;
    const m = map;

    const setup = () => {
      if (m.getSource("countries")) {
        setReady(true);
        return;
      }

      m.addSource("countries", {
        type: "geojson",
        data: COUNTRIES_GEOJSON_URL,
        promoteId: COUNTRY_CODE_PROPERTY,
      });

      m.addLayer({
        id: "countries-fill",
        type: "fill",
        source: "countries",
        paint: {
          "fill-color": "hsl(215, 15%, 50%)",
          "fill-opacity": 0.08,
        },
      });
      m.addLayer({
        id: "countries-visited",
        type: "fill",
        source: "countries",
        paint: { "fill-color": "#22c55e", "fill-opacity": 0.35 },
        filter: ["in", COUNTRY_CODE_PROPERTY, ""],
      });
      m.addLayer({
        id: "countries-hover",
        type: "fill",
        source: "countries",
        paint: { "fill-color": "#3b82f6", "fill-opacity": 0.25 },
        filter: ["==", COUNTRY_CODE_PROPERTY, ""],
      });
      m.addLayer({
        id: "countries-border",
        type: "line",
        source: "countries",
        paint: {
          "line-color": "hsl(215, 15%, 40%)",
          "line-width": 0.5,
          "line-opacity": 0.4,
        },
      });
      m.addLayer({
        id: "countries-visited-border",
        type: "line",
        source: "countries",
        paint: {
          "line-color": "#22c55e",
          "line-width": 1.5,
          "line-opacity": 0.7,
        },
        filter: ["in", COUNTRY_CODE_PROPERTY, ""],
      });

      m.on("mousemove", "countries-fill", (event) => {
        m.getCanvas().style.cursor = "pointer";
        const code = event.features?.[0]?.properties?.[COUNTRY_CODE_PROPERTY];
        if (typeof code === "string" && code !== "-99") {
          m.setFilter("countries-hover", ["==", COUNTRY_CODE_PROPERTY, code]);
        }
      });
      m.on("mouseleave", "countries-fill", () => {
        m.getCanvas().style.cursor = "";
        m.setFilter("countries-hover", ["==", COUNTRY_CODE_PROPERTY, ""]);
      });
      setReady(true);
    };

    if (m.isStyleLoaded()) setup();
    else m.on("load", setup);
    return () => {
      m.off("load", setup);
    };
  }, [isLoaded, map]);

  useEffect(() => {
    if (!map || !isLoaded || !ready || !map.getLayer("countries-visited")) return;
    const codes = Array.from(visitedCodes);
    const filter: ["in", string, ...string[]] = [
      "in",
      COUNTRY_CODE_PROPERTY,
      ...(codes.length ? codes : [""]),
    ];
    map.setFilter("countries-visited", filter);
    map.setFilter("countries-visited-border", filter);
  }, [isLoaded, map, ready, visitedCodes]);

  return null;
}

function CityCheckpoints({
  checkpoints,
  view,
}: {
  checkpoints: readonly TravelCheckpoint[];
  view: MapView;
}) {
  const routeLegs = useMemo(() => checkpointRouteLegs(checkpoints), [checkpoints]);

  return (
    <>
      {view === "globe" &&
        routeLegs.map((coordinates, index) => (
          <MapRoute
            key={`checkpoint-leg-${checkpoints[index].id}-${checkpoints[index + 1].id}`}
            id={`checkpoint-leg-${checkpoints[index].id}-${checkpoints[index + 1].id}`}
            coordinates={coordinates}
            color="#3b82f6"
            width={2}
            opacity={0.9}
            dashArray={[2, 2]}
            interactive={false}
          />
        ))}

      {checkpoints.map((checkpoint) => (
        <MapMarker
          key={checkpoint.id}
          longitude={checkpoint.longitude}
          latitude={checkpoint.latitude}
          anchor="bottom"
        >
          <MarkerContent className="group">
            <div
              className="relative grid h-8 w-8 place-items-center"
              aria-label={`${checkpoint.cityName} checkpoint`}
            >
              <span className="absolute h-4 w-4 animate-ping rounded-full bg-blue-500/35" />
              <MapPinCheck className="relative h-8 w-8 fill-blue-500 text-white drop-shadow-lg" />
              <MarkerLabel className="rounded bg-background/85 px-1.5 py-0.5 text-foreground shadow-sm backdrop-blur-sm">
                {checkpoint.cityName}
              </MarkerLabel>
            </div>
          </MarkerContent>
          <MarkerTooltip>
            {checkpoint.cityName} · {checkpoint.countryCode}
          </MarkerTooltip>
        </MapMarker>
      ))}
    </>
  );
}

export default function TravelMap({
  visitedCodes,
  checkpoints,
}: {
  visitedCodes: ReadonlySet<string>;
  checkpoints: readonly TravelCheckpoint[];
}) {
  const [view, setView] = useState<MapView>("flat");
  const mapRef = useRef<MapRef | null>(null);
  const projection = useMemo(
    () => ({ type: view === "globe" ? "globe" : "mercator" }) as const,
    [view],
  );

  const changeView = (next: MapView) => {
    setView(next);
    mapRef.current?.easeTo({
      center: [15, 25],
      zoom: next === "globe" ? 1.25 : 1.8,
      pitch: 0,
      bearing: 0,
      duration: 650,
    });
  };

  return (
    <div className="relative h-full min-h-0 w-full">
      <Map
        ref={mapRef}
        center={[15, 30]}
        zoom={1.8}
        projection={projection}
        className="h-full w-full"
      >
        <CountryLayers visitedCodes={visitedCodes} />
        <CityCheckpoints checkpoints={checkpoints} view={view} />
        <MapControls position="top-right" showCompass showZoom />
      </Map>

      <div
        className="absolute left-3 top-3 z-10 flex rounded-lg border bg-background/90 p-1 shadow-md backdrop-blur"
        role="group"
        aria-label="Map view"
      >
        <Button
          type="button"
          size="sm"
          variant={view === "flat" ? "secondary" : "ghost"}
          className="h-8 gap-1.5 px-2.5"
          aria-pressed={view === "flat"}
          onClick={() => changeView("flat")}
        >
          <MapIcon className="h-4 w-4" />
          Flat
        </Button>
        <Button
          type="button"
          size="sm"
          variant={view === "globe" ? "secondary" : "ghost"}
          className="h-8 gap-1.5 px-2.5"
          aria-pressed={view === "globe"}
          onClick={() => changeView("globe")}
        >
          <Globe2 className="h-4 w-4" />
          Globe
        </Button>
      </div>
    </div>
  );
}
