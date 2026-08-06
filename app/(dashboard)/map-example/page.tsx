import { Map, MapControls } from "@/components/ui/map";

export default function MapExamplePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Map Example</h1>
        <p className="text-muted-foreground">
          A basic mapcn map using the default tiled basemap.
        </p>
      </div>

      <div className="h-[320px] overflow-hidden rounded-lg border">
        <Map center={[-74.006, 40.7128]} zoom={11}>
          <MapControls />
        </Map>
      </div>
    </div>
  );
}
