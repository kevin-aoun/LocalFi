"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Loader2, MapPinPlus } from "lucide-react";

import { createTravelCheckpoint } from "@/app/actions/countries";
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
import type { TravelCheckpoint, VisitedCountry } from "@/lib/db/schema/countries";

export function CheckpointDialog({
  open,
  onOpenChange,
  countries,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  countries: readonly VisitedCountry[];
  onCreated: (checkpoint: TravelCheckpoint) => void;
}) {
  const [countryCode, setCountryCode] = useState("");
  const [cityName, setCityName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCountryCode(countries[0]?.countryCode ?? "");
    setCityName("");
    setError(null);
  }, [countries, open]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const formData = new FormData();
    formData.set("countryCode", countryCode);
    formData.set("cityName", cityName);
    const result = await createTravelCheckpoint(formData);
    setLoading(false);
    if ("error" in result) {
      setError(result.error ?? "Failed to add city checkpoint.");
      return;
    }
    onCreated(result.data);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MapPinPlus className="h-5 w-5" />
            Add city checkpoint
          </DialogTitle>
          <DialogDescription>
            Place a city you visited on both map views. Checkpoints are connected in the order
            you add them.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit}>
          {error && (
            <div
              role="alert"
              className="flex gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="space-y-2">
            <Label>Visited country</Label>
            <Select value={countryCode} onValueChange={setCountryCode} required>
              <SelectTrigger>
                <SelectValue placeholder="Choose a country" />
              </SelectTrigger>
              <SelectContent>
                {[...countries]
                  .sort((a, b) => a.countryName.localeCompare(b.countryName))
                  .map((country) => (
                    <SelectItem key={country.countryCode} value={country.countryCode}>
                      {country.countryName}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="checkpoint-city">City</Label>
            <Input
              id="checkpoint-city"
              value={cityName}
              onChange={(event) => setCityName(event.target.value)}
              placeholder="e.g. Beirut"
              maxLength={100}
              autoComplete="off"
              required
            />
          </div>

          <p className="text-xs text-muted-foreground">
            City lookup runs only when you submit and is provided by OpenStreetMap Nominatim.
            The resolved coordinates are then stored locally.
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !countryCode || !cityName.trim()}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add checkpoint
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
