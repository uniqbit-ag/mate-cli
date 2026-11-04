import type { StudioShippedChange } from "@uniqbit/mate-core/studio";

export interface ChangedSpec {
  capability: string;
  change: string;
  archivedOn: string;
}

/** Each capability once, at the newest shipped change that touched it. */
export function recentlyChangedSpecs(shipped: StudioShippedChange[]): ChangedSpec[] {
  const seen = new Set<string>();
  const changed: ChangedSpec[] = [];
  for (const change of shipped) {
    for (const capability of change.specs) {
      if (seen.has(capability)) continue;
      seen.add(capability);
      changed.push({ capability, change: change.name, archivedOn: change.archivedOn });
    }
  }
  return changed;
}
