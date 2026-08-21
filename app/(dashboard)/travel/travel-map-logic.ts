export type CityLabelPresentation =
  | { visible: false; displayedOrdinal: null; position: null }
  | {
      visible: true;
      displayedOrdinal: number;
      position: "top" | "bottom";
    };

export function cityLabelPresentations(cityCount: number): CityLabelPresentation[] {
  const normalizedCount = Math.max(0, Math.floor(cityCount));
  let displayedOrdinal = 0;

  return Array.from({ length: normalizedCount }, (_, index) => {
    const visible = normalizedCount <= 7 ||
      index === 0 ||
      index === normalizedCount - 1 ||
      index % 2 === 0;
    if (!visible) {
      return { visible: false, displayedOrdinal: null, position: null };
    }

    const presentation: CityLabelPresentation = {
      visible: true,
      displayedOrdinal,
      position: displayedOrdinal % 2 === 0 ? "top" : "bottom",
    };
    displayedOrdinal += 1;
    return presentation;
  });
}
