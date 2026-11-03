import { createServerFn } from "@tanstack/react-start";
import {
  companionDigest,
  healthNote,
  type StudioRole,
  type TerminalAgent,
} from "@uniqbit/mate-core/studio";

import { validateStudioSearch, type StudioSearch } from "../lib/search";

export interface ShellCompanion {
  digest: string;
  path: string;
  note: string;
  unready: boolean;
  /** Linked Working Repositories by identity. */
  pairings: string[];
}

/** What the sidebar and page header show, for every view. Digests only cross to the browser. */
export interface ShellData {
  companions: ShellCompanion[];
  selected: ShellCompanion | null;
  role: StudioRole;
  collectedAt: number | null;
  metrics: { changes: number; done: number; specs: number } | null;
  writable: boolean;
  /** The factory broker runs: only then is the Factory view offered. */
  factoryMode: boolean;
  /** The agent terminal; `null` when Studio runs without it. */
  terminal: ShellTerminal | null;
}

export interface ShellTerminal {
  /** Fixed to one companion when Studio started. */
  pinned: boolean;
  target: { path: string; digest: string } | null;
  agents: TerminalAgent[];
}

type ShellInput = StudioSearch & { refresh?: boolean };

/** `refresh` collects the companion again; every other call reads the held snapshot. */
export const getShell = createServerFn({ method: "GET" })
  .validator((input: ShellInput): ShellInput => ({
    ...validateStudioSearch(input),
    ...(input.refresh === true ? { refresh: true } : {}),
  }))
  .handler(async ({ data, context }): Promise<ShellData> => {
    const url = new URL("http://studio.local/");
    if (data.companion) url.searchParams.set("companion", data.companion);
    if (data.role) url.searchParams.set("role", data.role);
    if (data.refresh) url.searchParams.set("refresh", "1");
    const page = await context.studio.page(url);
    const companions = page.inventory.companions.map((companion) => ({
      digest: companionDigest(companion.path),
      path: companion.path,
      note: healthNote(companion),
      unready: companion.health !== "ready",
      pairings: companion.pairings.map((pairing) => pairing.repositoryId),
    }));
    const payload = page.payload;
    return {
      companions,
      selected: page.companion
        ? (companions.find((entry) => entry.path === page.companion!.path) ?? null)
        : null,
      role: page.selection.role,
      collectedAt: page.collectedAt,
      metrics: payload
        ? {
            changes: payload.changes.length,
            done: payload.changes.filter((change) => change.status === "complete").length,
            specs: payload.specs.length,
          }
        : null,
      writable: page.writable,
      factoryMode: context.studio.factoryMode,
      terminal: page.terminal
        ? {
            pinned: page.terminal.pinned,
            target: page.terminal.target,
            agents: page.terminal.agents,
          }
        : null,
    };
  });
