import { createServerFn } from "@tanstack/react-start";
import {
  COMPANION_PARAM,
  companionDigest,
  healthNote,
  STUDIO_MODE_PARAM,
  type StudioMode,
  type StudioProfile,
  type TerminalAgent,
} from "@uniqbit/mate-core/studio";

import { validateStudioSearch, type StudioSearch } from "../lib/search";

export interface ShellCompanion {
  digest: string;
  path: string;
  note: string;
  unready: boolean;
  /** Its folder is gone: deleting it only drops the registry entry. */
  missing?: boolean;
  /** Linked Working Repositories by identity. */
  pairings: string[];
  /** Removing it only unregisters it: the factory deletes folders only in its companions directory. */
  keepsFolder?: boolean;
}

/** What the sidebar and page header show, for every view. Digests only cross to the browser. */
export interface ShellData {
  companions: ShellCompanion[];
  selected: ShellCompanion | null;
  /** The effective mode, resolved by the server's startup profile. */
  studioMode: StudioMode;
  /** Modes the startup profile enables; the others are shown disabled. */
  enabledModes: StudioMode[];
  profile: StudioProfile;
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
    if (data.companion) url.searchParams.set(COMPANION_PARAM, data.companion);
    if (data.studioMode) url.searchParams.set(STUDIO_MODE_PARAM, data.studioMode);
    if (data.refresh) url.searchParams.set("refresh", "1");
    const page = await context.studio.page(url);
    const companions = page.inventory.companions.map((companion) => ({
      digest: companionDigest(companion.path),
      path: companion.path,
      note: healthNote(companion),
      unready: companion.health !== "ready",
      missing: companion.health === "missing",
      pairings: companion.pairings.map((pairing) => pairing.repositoryId),
      ...(context.studio.keepsFolder(companion.path) ? { keepsFolder: true } : {}),
    }));
    const payload = page.payload;
    return {
      companions,
      selected: page.companion
        ? (companions.find((entry) => entry.path === page.companion!.path) ?? null)
        : null,
      studioMode: page.selection.studioMode,
      enabledModes: [...context.studio.modePolicy.enabled],
      profile: context.studio.modePolicy.profile,
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
