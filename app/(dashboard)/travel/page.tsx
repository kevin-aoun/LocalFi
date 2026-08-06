"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { getVisitedCountries, toggleCountry } from "@/app/actions/countries";
import type { VisitedCountry } from "@/lib/db/schema/countries";
import { COUNTRIES, COUNTRIES_BY_ALPHA3 } from "@/lib/countries";
import * as Flags from "country-flag-icons/react/3x2";
import { Globe, X, Plus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";

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
  const [loading, setLoading] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    getVisitedCountries().then((data) => {
      setVisited(data);
      setLoading(false);
    });
  }, []);

  const visitedCodes = new Set(visited.map((v) => v.countryCode));

  const handleAdd = async (alpha3: string) => {
    const country = COUNTRIES_BY_ALPHA3.get(alpha3);
    if (!country || visitedCodes.has(alpha3)) return;

    setSearchOpen(false);

    // Optimistic update
    setVisited((prev) => [
      ...prev,
      { id: Date.now(), countryCode: alpha3, countryName: country.name, visitedAt: new Date().toISOString() },
    ]);

    const result = await toggleCountry(alpha3, country.name);
    if ("error" in result) {
      const fresh = await getVisitedCountries();
      setVisited(fresh);
    }
  };

  const handleRemove = async (code: string, name: string) => {
    setVisited((prev) => prev.filter((v) => v.countryCode !== code));
    const result = await toggleCountry(code, name);
    if ("error" in result) {
      const fresh = await getVisitedCountries();
      setVisited(fresh);
    }
  };

  // Countries not yet visited, for the search
  const availableCountries = COUNTRIES.filter((c) => !visitedCodes.has(c.alpha3));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Travel Map</h1>
        <p className="text-muted-foreground">
          Track the countries you&apos;ve been to
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2 h-[500px] rounded-lg border bg-card overflow-hidden p-4">
          <TravelMap visitedCodes={visitedCodes} />
        </div>

        <div className="rounded-lg border bg-card p-4 flex flex-col">
          <div className="mb-3 flex items-center gap-2">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-semibold">Visited</h2>
            <span className="ml-auto rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-500">
              {visited.length}
            </span>
          </div>

          {/* Add country search */}
          <Popover open={searchOpen} onOpenChange={setSearchOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="w-full mb-3 justify-start gap-2 text-muted-foreground">
                <Plus className="h-3.5 w-3.5" />
                Add a country...
              </Button>
            </PopoverTrigger>
            <PopoverContent className="p-0 w-[280px]" align="start">
              <Command>
                <CommandInput placeholder="Search countries..." />
                <CommandList>
                  <CommandEmpty>No country found.</CommandEmpty>
                  <CommandGroup>
                    {availableCountries.map((c) => (
                      <CommandItem
                        key={c.alpha3}
                        value={c.name}
                        onSelect={() => handleAdd(c.alpha3)}
                      >
                        <Flag code={c.alpha2} className="inline-block w-5 h-auto mr-2 rounded-sm" />
                        {c.name}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>

          {loading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
              Loading...
            </div>
          ) : visited.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center flex-1">
              <Globe className="h-8 w-8 text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">
                No countries visited yet.
                <br />
                Use the button above to add one!
              </p>
            </div>
          ) : (
            <div className="space-y-0.5 max-h-[380px] overflow-y-auto flex-1">
              {[...visited]
                .sort((a, b) => a.countryName.localeCompare(b.countryName))
                .map((country) => {
                  const info = COUNTRIES_BY_ALPHA3.get(country.countryCode);
                  return (
                    <div
                      key={country.countryCode}
                      className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-muted/50 group"
                    >
                      <span className="flex items-center gap-2">
                        {info && <Flag code={info.alpha2} className="w-5 h-auto rounded-sm" />}
                        <span>{country.countryName}</span>
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => handleRemove(country.countryCode, country.countryName)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
