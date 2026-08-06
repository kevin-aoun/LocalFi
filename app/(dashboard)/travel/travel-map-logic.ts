import { geoInterpolate } from "d3-geo";

export const COUNTRY_CODE_PROPERTY = "ISO3166-1-Alpha-3";

export type CheckpointCoordinate = {
  longitude: number;
  latitude: number;
};

/** Great-circle legs sampled densely enough to curve over MapLibre's globe. */
export function checkpointRouteLegs(
  checkpoints: readonly CheckpointCoordinate[],
  samplesPerLeg = 48,
): [number, number][][] {
  if (!Number.isInteger(samplesPerLeg) || samplesPerLeg < 2) {
    throw new Error("samplesPerLeg must be an integer of at least 2");
  }

  const legs: [number, number][][] = [];
  for (let index = 1; index < checkpoints.length; index += 1) {
    const start = checkpoints[index - 1];
    const end = checkpoints[index];
    const interpolate = geoInterpolate(
      [start.longitude, start.latitude],
      [end.longitude, end.latitude],
    );
    legs.push(
      Array.from({ length: samplesPerLeg + 1 }, (_, sample) =>
        interpolate(sample / samplesPerLeg),
      ),
    );
  }
  return legs;
}
