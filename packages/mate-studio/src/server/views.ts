import { createServerFn } from "@tanstack/react-start";
import {
  COMPANION_DIGEST_PATTERN,
  COMPANION_PARAM,
  companionDigest,
  type SpecActionOffer,
  specActionOffers,
  STUDIO_MODE_PARAM,
  type StudioCompanionPayload,
  type StudioMode,
  type StudioReportSummary,
  VIEW_PARAM,
} from "@uniqbit/mate-core/studio";

import { validateStudioSearch, type StudioSearch } from "../lib/search";

/** The companion views this function answers; Factory and Vault have their own. */
export type CompanionView = "dashboard" | "workflow" | "skills" | "specs";

/** What each view reads from the payload; nothing else crosses to the browser. */
export interface CompanionViewData {
  error: { companionPath: string; reason: string } | null;
  /** The effective mode the server answered for; it picks the Overview. */
  studioMode: StudioMode;
  /** Overview, Engineering. */
  changes?: StudioCompanionPayload["changes"];
  /** Overview, Analysis. */
  shipped?: StudioCompanionPayload["shipped"];
  reports?: StudioReportSummary[] | null;
  specs?: StudioCompanionPayload["specs"];
  /** Workflow. */
  skills?: StudioCompanionPayload["skills"];
  topology?: StudioCompanionPayload["topology"];
  skillInventory?: StudioCompanionPayload["skillInventory"];
  /** Spec actions by id; the browser rebuilds each offer's prompts from core's action list. */
  actions?: {
    id: string;
    runAgents: SpecActionOffer["runAgents"];
    copyAgents: SpecActionOffer["copyAgents"];
  }[];
  warnings: string[];
}

type Input = StudioSearch & { view: CompanionView };

const VIEWS: ReadonlySet<CompanionView> = new Set(["dashboard", "workflow", "skills", "specs"]);

export const getCompanionView = createServerFn({ method: "GET" })
  .validator((input: Input): Input => {
    if (!VIEWS.has(input?.view)) throw new Error("unknown view");
    const search = validateStudioSearch(input);
    if (!search.companion || !COMPANION_DIGEST_PATTERN.test(search.companion)) {
      throw new Error("no registered companion was selected");
    }
    return { ...search, view: input.view };
  })
  .handler(async ({ data, context }): Promise<CompanionViewData> => {
    const url = new URL("http://studio.local/");
    url.searchParams.set(COMPANION_PARAM, data.companion!);
    url.searchParams.set(VIEW_PARAM, data.view);
    if (data.studioMode) url.searchParams.set(STUDIO_MODE_PARAM, data.studioMode);
    const page = await context.studio.page(url);
    if (!page.companion || companionDigest(page.companion.path) !== data.companion) {
      throw new Error("no registered companion was selected");
    }
    const studioMode = page.selection.studioMode;
    if (page.error) return { error: page.error, studioMode, warnings: [] };
    const payload = page.payload;
    if (!payload)
      return {
        error: {
          companionPath: page.companion.path,
          reason: "No state collected for this companion.",
        },
        studioMode,
        warnings: [],
      };
    const base = { error: null, studioMode, warnings: payload.warnings };
    // The view the server resolved, not the one asked for: a mode never answers another's view.
    const view = page.selection.view;
    if (view === "workflow") return { ...base, skills: payload.skills, topology: payload.topology };
    if (view === "skills") return { ...base, skillInventory: payload.skillInventory };
    if (view === "specs") {
      return {
        ...base,
        specs: payload.specs,
        actions: specActionOffers(payload.companionPath, payload.skillInventory, page.terminal).map(
          ({ action, runAgents, copyAgents }) => ({ id: action.id, runAgents, copyAgents }),
        ),
      };
    }
    return studioMode === "analysis"
      ? { ...base, specs: payload.specs, shipped: payload.shipped, reports: page.reports ?? null }
      : { ...base, changes: payload.changes };
  });
