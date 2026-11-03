import type { StudioMode, StudioView } from "@uniqbit/mate-core/studio";

/** The path each view is served at. */
export const VIEW_PATHS: Record<StudioView, string> = {
  dashboard: "/",
  factory: "/factory",
  workflow: "/workflow",
  skills: "/skills",
  vault: "/vault",
  specs: "/specs",
  reports: "/reports",
};

/** A view's page title is its navigation label. */
export const VIEW_TITLES: Record<StudioView, string> = {
  dashboard: "Overview",
  factory: "Factory",
  workflow: "Workflow",
  skills: "Skills",
  vault: "Vault",
  specs: "Specs",
  reports: "Reports",
};

export const MODE_TITLES: Record<StudioMode, string> = {
  engineering: "Engineering",
  analysis: "Analysis",
};

/** The view a path serves, for guards that see only the location. */
export function viewAt(pathname: string): StudioView | undefined {
  const entry = Object.entries(VIEW_PATHS).find(([, path]) => path === pathname);
  return entry?.[0] as StudioView | undefined;
}
