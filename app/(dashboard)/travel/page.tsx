"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import * as Flags from "country-flag-icons/react/3x2";
import { AlertCircle, Globe2, Loader2, MapPinPlus, Trash2 } from "lucide-react";

import { addTravelCity, deleteTravelCity, getTravelCities } from "@/app/actions/travel";
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

function CityDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (city: TravelCity) => void;
}) {
  const [countryCode, setCountryCode] = useState("");
  const [cityName, setCityName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCountryCode("");
    setCityName("");
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
            Your first city is the hub. Every city after it is connected to that hub on the map.
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
  const [error, setError] = useState<string | null>(null);

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
    setCities((current) => current.filter((item) => item.id !== city.id));
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
              {cities.map((city, index) => {
                const country = COUNTRIES_BY_ALPHA3.get(city.countryCode);
                return (
                  <div
                    key={city.id}
                    className="group flex items-center gap-3 rounded-lg border bg-background/40 p-3"
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-white bg-blue-500 text-xs font-semibold text-white">
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 font-medium">
                        <span className="truncate">{city.cityName}</span>
                        {index === 0 && (
                          <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-500">
                            Hub
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                        {country && <Flag code={country.alpha2} />}
                        {city.countryName}
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus:opacity-100"
                      aria-label={`Remove ${city.cityName}`}
                      disabled={deletingId === city.id}
                      onClick={() => removeCity(city)}
                    >
                      {deletingId === city.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Trash2 className="size-4" />
                      )}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </aside>
      </div>

      <CityDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={(city) => setCities((current) => [...current, city])}
      />
    </div>
  );
}
