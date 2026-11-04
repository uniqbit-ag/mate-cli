import type { StudioSpec } from "@uniqbit/mate-core/studio";

const UNASSIGNED_AREA = "unassigned";

/** A spec binds one Area or several, so it appears under each of them. */
export function groupSpecsByArea(specs: StudioSpec[]): [string, StudioSpec[]][] {
  const groups = new Map<string, StudioSpec[]>();
  for (const spec of specs) {
    const areas = spec.areas.length > 0 ? spec.areas : [UNASSIGNED_AREA];
    for (const area of areas) {
      const existing = groups.get(area);
      if (existing) existing.push(spec);
      else groups.set(area, [spec]);
    }
  }
  return [...groups.entries()].toSorted((left, right) => left[0].localeCompare(right[0]));
}
