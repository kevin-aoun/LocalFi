"use client";

import { useEffect, useState } from "react";
import { Map, MapControls, useMap } from "@/components/ui/map";

const COUNTRIES_GEOJSON_URL =
  "https://r2.datahub.io/clvyjaryy0000la0cxieg4o8o/main/raw/data/countries.geojson";

function CountryLayers({
  visitedCodes,
}: {
  visitedCodes: Set<string>;
}) {
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
        promoteId: "ISO_A3",
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
        paint: {
          "fill-color": "#22c55e",
          "fill-opacity": 0.35,
        },
        filter: ["in", "ISO_A3", ""],
      });

      m.addLayer({
        id: "countries-hover",
        type: "fill",
        source: "countries",
        paint: {
          "fill-color": "#3b82f6",
          "fill-opacity": 0.25,
        },
        filter: ["==", "ISO_A3", ""],
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
          "line-opacity": 0.6,
        },
        filter: ["in", "ISO_A3", ""],
      });

      m.on("mousemove", "countries-fill", (e) => {
        m.getCanvas().style.cursor = "pointer";
        const feature = e.features?.[0];
        if (feature?.properties) {
          const code = feature.properties.ISO_A3;
          if (code && code !== "-99") {
            m.setFilter("countries-hover", ["==", "ISO_A3", code]);
          }
        }
      });

      m.on("mouseleave", "countries-fill", () => {
        m.getCanvas().style.cursor = "";
        m.setFilter("countries-hover", ["==", "ISO_A3", ""]);
      });

      setReady(true);
    };

    if (m.isStyleLoaded()) {
      setup();
    } else {
      m.on("load", setup);
    }

    return () => {
      m.off("load", setup);
    };
  }, [map, isLoaded]);

  // Update visited filter whenever visitedCodes changes
  useEffect(() => {
    if (!map || !isLoaded || !ready) return;
    const m = map;

    if (!m.getLayer("countries-visited")) return;
    const codes = Array.from(visitedCodes);
    m.setFilter("countries-visited", ["in", "ISO_A3", ...codes]);
    m.setFilter("countries-visited-border", ["in", "ISO_A3", ...codes]);
  }, [map, isLoaded, ready, visitedCodes]);

  return null;
}

export default function TravelMap({
  visitedCodes,
}: {
  visitedCodes: Set<string>;
}) {
  return (
    <Map center={[15, 30]} zoom={1.8} className="h-full w-full">
      <CountryLayers visitedCodes={visitedCodes} />
      <MapControls position="top-right" showCompass showZoom />
    </Map>
  );
}
