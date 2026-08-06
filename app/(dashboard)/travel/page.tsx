"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import * as Flags from "country-flag-icons/react/3x2";
import { Globe, Loader2, MapPin, MapPinPlus, Plus, X } from "lucide-react";

import {
  deleteTravelCheckpoint,
  getTravelCheckpoints,
  getVisitedCountries,
  toggleCountry,
} from "@/app/actions/countries";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { COUNTRIES, COUNTRIES_BY_ALPHA3 } from "@/lib/countries";
import type { TravelCheckpoint, VisitedCountry } from "@/lib/db/schema/countries";

import { CheckpointDialog } from "./checkpoint-dialog";

function Flag({ code, className }: { code: string; className?: string }) {
  const Component = (Flags as Record<string, React.ComponentType<React.SVGProps<SVGSVGElement>>>)[code];
  if (!Component) return null;
  return <Component className={className} />;
}

const TravelMap = dynamic(() => import("./travel-map"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <Loader2 className="h-6 w-6 animate-spin" />
    </div>
  ),
});

export default function TravelPage() {
  const [visited, setVisited] = useState<VisitedCountry[]>([]);
  const [checkpoints, setCheckpoints] = useState<TravelCheckpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [checkpointDialogOpen, setCheckpointDialogOpen] = useState(false);

  useEffect(() => {
    Promise.all([getVisitedCountries(), getTravelCheckpoints()]).then(([countries, points]) => {
      setVisited(countries);
      setCheckpoints(points);
      setLoading(false);
    });
  }, []);

  const visitedCodes = useMemo(() => new Set(visited.map((country) => country.countryCode)), [visited]);
  const availableCountries = COUNTRIES.filter((country) => !visitedCodes.has(country.alpha3));

  const reloadTravel = async () => {
    const [countries, points] = await Promise.all([getVisitedCountries(), getTravelCheckpoints()]);
    setVisited(countries);
    setCheckpoints(points);
  };

  const handleAdd = async (alpha3: string) => {
    const country = COUNTRIES_BY_ALPHA3.get(alpha3);
    if (!country || visitedCodes.has(alpha3)) return;
    setSearchOpen(false);
    setVisited((current) => [
      ...current,
      {
        id: Date.now(),
        countryCode: alpha3,
        countryName: country.name,
        visitedAt: new Date().toISOString(),
      },
    ]);
    const result = await toggleCountry(alpha3, country.name);
    if ("error" in result) await reloadTravel();
  };

  const handleRemoveCountry = async (code: string, name: string) => {
    setVisited((current) => current.filter((country) => country.countryCode !== code));
    setCheckpoints((current) => current.filter((checkpoint) => checkpoint.countryCode !== code));
    const result = await toggleCountry(code, name);
    if ("error" in result) await reloadTravel();
  };

  const handleRemoveCheckpoint = async (checkpoint: TravelCheckpoint) => {
    setCheckpoints((current) => current.filter((item) => item.id !== checkpoint.id));
    const result = await deleteTravelCheckpoint(checkpoint.id);
    if ("error" in result) await reloadTravel();
  };

  const sortedVisited = [...visited].sort((a, b) => a.countryName.localeCompare(b.countryName));

  return (
    <div className="flex h-full min-h-[42rem] min-w-0 flex-col gap-6">
      <header className="shrink-0">
        <h1 className="text-3xl font-bold tracking-tight">Travel Map</h1>
        <p className="text-muted-foreground">
          Track countries and pin the cities you have visited
        </p>
      </header>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="relative min-h-[32rem] overflow-hidden rounded-xl border bg-card">
          <TravelMap visitedCodes={visitedCodes} checkpoints={checkpoints} />
        </section>

        <aside className="flex min-h-0 flex-col rounded-xl border bg-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-semibold">Visited</h2>
            <span className="ml-auto rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-500">
              {visited.length} countries
            </span>
          </div>

          <div className="mb-3 grid grid-cols-2 gap-2">
            <Popover open={searchOpen} onOpenChange={setSearchOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="justify-start gap-2 text-muted-foreground">
                  <Plus className="h-3.5 w-3.5" />
                  Country
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[280px] p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search countries..." />
                  <CommandList>
                    <CommandEmpty>No country found.</CommandEmpty>
                    <CommandGroup>
                      {availableCountries.map((country) => (
                        <CommandItem
                          key={country.alpha3}
                          value={country.name}
                          onSelect={() => handleAdd(country.alpha3)}
                        >
                          <Flag code={country.alpha2} className="mr-2 inline-block h-auto w-5 rounded-sm" />
                          {country.name}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

            <Button
              variant="outline"
              size="sm"
              className="justify-start gap-2 text-muted-foreground"
              disabled={visited.length === 0}
              onClick={() => setCheckpointDialogOpen(true)}
            >
              <MapPinPlus className="h-3.5 w-3.5" />
              City
            </Button>
          </div>

          {loading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Loading...
            </div>
          ) : visited.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
              <Globe className="mb-2 h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Add a country, then pin the cities you visited there.
              </p>
            </div>
          ) : (
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {sortedVisited.map((country) => {
                const info = COUNTRIES_BY_ALPHA3.get(country.countryCode);
                const cities = checkpoints.filter(
                  (checkpoint) => checkpoint.countryCode === country.countryCode,
                );
                return (
                  <div key={country.countryCode} className="rounded-lg border bg-background/40 p-2">
                    <div className="group flex items-center justify-between gap-2 text-sm">
                      <span className="flex min-w-0 items-center gap-2 font-medium">
                        {info && <Flag code={info.alpha2} className="h-auto w-5 shrink-0 rounded-sm" />}
                        <span className="truncate">{country.countryName}</span>
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 shrink-0 p-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                        aria-label={`Remove ${country.countryName}`}
                        onClick={() => handleRemoveCountry(country.countryCode, country.countryName)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>

                    {cities.length > 0 && (
                      <div className="mt-1.5 space-y-0.5 border-l border-blue-500/30 pl-2">
                        {cities.map((checkpoint) => (
                          <div
                            key={checkpoint.id}
                            className="group/city flex items-center gap-1.5 rounded px-1 py-1 text-xs text-muted-foreground hover:bg-muted/50"
                          >
                            <MapPin className="h-3 w-3 shrink-0 text-blue-500" />
                            <span className="min-w-0 flex-1 truncate">{checkpoint.cityName}</span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-5 w-5 shrink-0 p-0 opacity-0 group-hover/city:opacity-100 focus:opacity-100"
                              aria-label={`Remove ${checkpoint.cityName} checkpoint`}
                              onClick={() => handleRemoveCheckpoint(checkpoint)}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </aside>
      </div>

      <CheckpointDialog
        open={checkpointDialogOpen}
        onOpenChange={setCheckpointDialogOpen}
        countries={visited}
        onCreated={(checkpoint) => setCheckpoints((current) => [...current, checkpoint])}
      />
    </div>
  );
}
