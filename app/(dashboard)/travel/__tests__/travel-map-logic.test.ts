import { describe, expect, it } from "vitest";

import { cityLabelPresentations } from "../travel-map-logic";

const visibleIndexes = (cityCount: number) =>
  cityLabelPresentations(cityCount)
    .map((label, index) => label.visible ? index : null)
    .filter((index): index is number => index !== null);

const visiblePositions = (cityCount: number) =>
  cityLabelPresentations(cityCount)
    .filter((label) => label.visible)
    .map((label) => label.position);

describe("travel map marker labels", () => {
  it.each([
    [0, []],
    [1, [0]],
    [3, [0, 1, 2]],
    [7, [0, 1, 2, 3, 4, 5, 6]],
    [8, [0, 2, 4, 6, 7]],
    [11, [0, 2, 4, 6, 8, 10]],
  ])("selects labels for %i cities", (cityCount, expected) => {
    expect(visibleIndexes(cityCount)).toEqual(expected);
  });

  it.each([1, 3, 7, 8, 11])("keeps both endpoints visible for %i cities", (cityCount) => {
    const labels = cityLabelPresentations(cityCount);
    expect(labels[0].visible).toBe(true);
    expect(labels[cityCount - 1].visible).toBe(true);
  });

  it.each([1, 3, 7, 8, 11])(
    "alternates placement by displayed-label order for %i cities",
    (cityCount) => {
      const positions = visiblePositions(cityCount);
      expect(positions).toEqual(
        positions.map((_, index) => index % 2 === 0 ? "top" : "bottom"),
      );
    },
  );
});
