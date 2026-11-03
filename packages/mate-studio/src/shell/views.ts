import type { StudioRole, StudioView } from "@uniqbit/mate-core/studio";

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

export const ROLE_TITLES: Record<StudioRole, string> = {
  "product-engineer": "Product Engineer",
  "business-analyst": "Business Analyst",
};
