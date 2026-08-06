"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import * as Flags from "country-flag-icons/react/3x2";
import {
  AlertCircle,
  ChevronRight,
  Globe2,
  Loader2,
  MapPinPlus,
  Trash2,
} from "lucide-react";

import {
  addTravelCity,
  deleteTravelCity,
  getTravelCities,
  setTravelCityOrigin,
} from "@/app/actions/travel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { COUNTRIES, COUNTRIES_BY_ALPHA3 } from "@/lib/countries";
import type { TravelCity } from "@/lib/db/schema";

const TravelMap = dynamic(() => import("./travel-map"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <Loader2 className="size-6 animate-spin" />
    </div>
  ),
});

function Flag({ code }: { code: string }) {
  const Component = (Flags as Record<string, React.ComponentType<React.SVGProps<SVGSVGElement>>>)[code];
  return Component ? <Component className="h-auto w-5 shrink-0 rounded-sm" /> : null;
}

function groupCitiesByCountry(cities: readonly TravelCity[]) {
  const groups = new Map<string, { countryName: string; cities: TravelCity[] }>();
  for (const city of cities) {
    const group = groups.get(city.countryCode);
    if (group) group.cities.push(city);
    else groups.set(city.countryCode, { countryName: city.countryName, cities: [city] });
  }
  return [...groups.entries()]
    .map(([countryCode, group]) => ({ countryCode, ...group }))
    .sort((left, right) => left.countryName.localeCompare(right.countryName));
}

function CityDialog({
  open,
  onOpenChange,
  cities,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cities: readonly TravelCity[];
  onCreated: (city: TravelCity) => void;
}) {
  const [countryCode, setCountryCode] = useState("");
  const [cityName, setCityName] = useState("");
  const [originCityId, setOriginCityId] = useState("none");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCountryCode("");
    setCityName("");
    setOriginCityId("none");
    setError(null);
  }, [open]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const formData = new FormData(event.currentTarget);
    const result = await addTravelCity(formData);
    setSubmitting(false);

    if ("error" in result) {
      setError(result.error ?? "Failed to add city.");
      return;
    }

    onCreated(result.data);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a visited city</DialogTitle>
          <DialogDescription>
            Add the city, then optionally connect it to the city you travelled from.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={submit}>
          {error && (
            <div
              role="alert"
              className="flex gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="travel-country">Country</Label>
            <Select name="countryCode" value={countryCode} onValueChange={setCountryCode} required>
              <SelectTrigger id="travel-country">
                <SelectValue placeholder="Choose a country" />
              </SelectTrigger>
              <SelectContent>
                {COUNTRIES.map((country) => (
                  <SelectItem key={country.alpha3} value={country.alpha3}>
                    {country.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="travel-city">City</Label>
            <Input
              id="travel-city"
              name="cityName"
              value={cityName}
              onChange={(event) => setCityName(event.target.value)}
              placeholder="e.g. Beirut"
              maxLength={100}
              autoComplete="off"
              required
            />
          </div>

          {cities.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="travel-origin">Travelled from (optional)</Label>
              <Select
                name="originCityId"
                value={originCityId}
                onValueChange={setOriginCityId}
              >
                <SelectTrigger id="travel-origin">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No connection</SelectItem>
                  {cities.map((city) => (
                    <SelectItem key={city.id} value={String(city.id)}>
                      {city.cityName}, {city.countryName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            OpenStreetMap Nominatim resolves the city once when you submit. LocalFi stores only
            the resulting coordinates.
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !countryCode || !cityName.trim()}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              Add city
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function TravelPage() {
  const [cities, setCities] = useState<TravelCity[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [updatingId, setUpdatingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const countryGroups = groupCitiesByCountry(cities);

  useEffect(() => {
    let active = true;
    getTravelCities()
      .then((data) => {
        if (active) setCities(data);
      })
      .catch(() => {
        if (active) setError("Could not load your travel cities.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const removeCity = async (city: TravelCity) => {
    setDeletingId(city.id);
    setError(null);
    const result = await deleteTravelCity(city.id);
    setDeletingId(null);
    if ("error" in result) {
      setError(result.error ?? `Could not remove ${city.cityName}.`);
      return;
    }
    setCities((current) =>
      current
        .filter((item) => item.id !== city.id)
        .map((item) =>
          item.originCityId === city.id ? { ...item, originCityId: null } : item,
        ),
    );
  };

  const changeOrigin = async (city: TravelCity, value: string) => {
    const originCityId = value === "none" ? null : Number(value);
    setUpdatingId(city.id);
    setError(null);
    const result = await setTravelCityOrigin(city.id, originCityId);
    setUpdatingId(null);
    if ("error" in result) {
      setError(result.error ?? `Could not update ${city.cityName}.`);
      return;
    }
    setCities((current) =>
      current.map((item) => (item.id === city.id ? { ...item, originCityId } : item)),
    );
  };

  return (
    <div className="flex h-full min-h-[42rem] min-w-0 flex-col gap-6">
      <header className="shrink-0">
        <h1 className="text-3xl font-bold tracking-tight">Travel Map</h1>
        <p className="text-muted-foreground">Map the cities you have visited.</p>
      </header>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="relative min-h-[32rem] overflow-hidden rounded-xl border bg-card">
          <TravelMap cities={cities} />
        </section>

        <aside className="flex min-h-0 flex-col rounded-xl border bg-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <Globe2 className="size-4 text-muted-foreground" />
            <h2 className="font-semibold">Itinerary</h2>
            <span className="ml-auto text-xs text-muted-foreground">
              {cities.length} {cities.length === 1 ? "city" : "cities"}
            </span>
          </div>

          <Button
            variant="outline"
            size="sm"
            className="mb-3 w-full justify-start gap-2"
            onClick={() => setDialogOpen(true)}
          >
            <MapPinPlus className="size-4" />
            Add city
          </Button>

          {error && (
            <p role="alert" className="mb-3 text-sm text-destructive">
              {error}
            </p>
          )}

          {loading ? (
            <div className="flex flex-1 items-center justify-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : cities.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center px-4 text-center">
              <Globe2 className="mb-3 size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Add your first city to start the map.
              </p>
            </div>
          ) : (
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {countryGroups.map((group) => {
                const country = COUNTRIES_BY_ALPHA3.get(group.countryCode);
                return (
                  <details
                    key={group.countryCode}
                    className="group/country rounded-lg border bg-background/40 p-2"
                  >
                    <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-1 py-1 text-sm font-medium outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open/country:rotate-90" />
                      {country && <Flag code={country.alpha2} />}
                      <span className="min-w-0 flex-1 truncate">{group.countryName}</span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {group.cities.length}
                      </span>
                    </summary>

                    <div className="mt-1 space-y-1 border-l border-blue-500/30 pl-2">
                      {group.cities.map((city) => (
                        <div
                          key={city.id}
                          className="group/city rounded-md px-1.5 py-1.5 hover:bg-muted/50"
                        >
                          <div className="flex items-center gap-2">
                            <span className="size-2 shrink-0 rounded-full bg-blue-500" />
                            <span className="min-w-0 flex-1 truncate text-sm">{city.cityName}</span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/city:opacity-100 focus:opacity-100"
                              aria-label={`Remove ${city.cityName}`}
                              disabled={deletingId === city.id}
                              onClick={() => removeCity(city)}
                            >
                              {deletingId === city.id ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="size-3.5" />
                              )}
                            </Button>
                          </div>

                          {cities.length > 1 && (
                            <Select
                              value={city.originCityId === null ? "none" : String(city.originCityId)}
                              onValueChange={(value) => changeOrigin(city, value)}
                              disabled={updatingId === city.id}
                            >
                              <SelectTrigger
                                className="mt-1 h-7 border-0 bg-transparent px-4 text-xs text-muted-foreground shadow-none"
                                aria-label={`Route origin for ${city.cityName}`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">No connection</SelectItem>
                                {cities
                                  .filter((origin) => origin.id !== city.id)
                                  .map((origin) => (
                                    <SelectItem key={origin.id} value={String(origin.id)}>
                                      From {origin.cityName}, {origin.countryName}
                                    </SelectItem>
                                  ))}
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                );
              })}
            </div>
          )}
        </aside>
      </div>

      <CityDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        cities={cities}
        onCreated={(city) => setCities((current) => [...current, city])}
      />
    </div>
  );
}
