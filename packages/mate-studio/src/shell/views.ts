import type { StudioMode, StudioView } from "@uniqbit/mate-core/studio";

/** The path each view is served at. */
export const VIEW_PATHS: Record<StudioView, string> = {
  dashboard: "/",
  workflow: "/workflow",
  "getting-started": "/getting-started",
  skills: "/skills",
  mcp: "/mcp",
  vault: "/vault",
  specs: "/specs",
  reports: "/reports",
  usage: "/usage",
  friction: "/friction",
  graph: "/graph",
};

/** A view's page title is its navigation label. */
export const VIEW_TITLES: Record<StudioView, string> = {
  dashboard: "Overview",
  workflow: "Workflow",
  "getting-started": "Getting Started",
  skills: "Skills",
  mcp: "MCP",
  vault: "Vault",
  specs: "Specs",
  reports: "Reports",
  usage: "Usage",
  friction: "Friction",
  graph: "Graph",
};

export const MODE_TITLES: Record<StudioMode, string> = {
  engineering: "Engineering",
  analysis: "Analysis",
};

/** The view a path serves, for guards that see only the location. */
export function viewAt(pathname: string): StudioView | undefined {
  if (pathname.startsWith("/getting-started/")) return "getting-started";
  const entry = Object.entries(VIEW_PATHS).find(([, path]) => path === pathname);
  return entry?.[0] as StudioView | undefined;
}

/** One plain line under each view's title. */
export const VIEW_DESCRIPTIONS: Record<StudioMode, Record<StudioView, string>> = {
  engineering: {
    dashboard: "Changes in flight, grouped by what they need next.",
    workflow: "The Delivery Path: every stage, its skill and where your changes are.",
    "getting-started": "Take your first change from an idea to delivery in your existing checkout.",
    skills: "The skills each agent can run in this companion.",
    mcp: "The MCP servers this companion gives its agents, per audience.",
    vault: "Every file in the Companion Repository.",
    specs: "Capabilities by Area, with their requirements.",
    reports: "Reports agents published for this companion.",
    usage: "Token usage across this companion and every linked Working Repository.",
    friction: "Where Mate got in your agents' way, recorded on this machine.",
    graph: "Capabilities, Areas and repositories, and how they connect.",
  },
  analysis: {
    dashboard: "What shipped lately, and the specs it changed.",
    workflow: "The Delivery Path.",
    "getting-started": "Developer setup and isolated work.",
    skills: "Skills in this companion.",
    mcp: "MCP servers in this companion.",
    vault: "Every file in the Companion Repository.",
    specs: "Capabilities by Area, with their requirements.",
    reports: "Reports agents published for this companion.",
    usage: "Token usage across this companion and every linked Working Repository.",
    friction: "Where Mate got in the agents' way, recorded on this machine.",
    graph: "Capabilities, Areas and repositories, and how they connect.",
  },
};
