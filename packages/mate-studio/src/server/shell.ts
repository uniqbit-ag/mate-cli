import { createServerFn } from "@tanstack/react-start";
import {
  COMPANION_PARAM,
  companionDigest,
  healthNote,
  STUDIO_MODE_PARAM,
  type StudioMode,
  type StudioProfile,
  type StudioViewLayout,
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
  /** Removing it only unregisters it: a service's companion source deletes folders only in its own folder. */
  keepsFolder?: boolean;
  /** Its path with links followed, when that differs; the chat's agent reports paths from it. */
  realPath?: string;
}

function withRealPath(companion: ShellCompanion, realPath: string): ShellCompanion {
  return realPath === companion.path ? companion : { ...companion, realPath };
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
  /** The Analysis Chat view is offered: on a localhost-only Studio, or in the appliance. */
  chat: boolean;
  /** A plugin service adds companions by Git URL: only then can the picker add one. */
  addsCompanions: boolean;
  /** Views plugin services ship as their own modules, in navigation order. */
  pluginViews: ShellPluginView[];
  /** The agent terminal; `null` when Studio runs without it. */
  terminal: ShellTerminal | null;
}

export interface ShellPluginView {
  service: string;
  view: string;
  label: string;
  description?: string;
  /** Where Studio serves the view's module. */
  moduleUrl: string;
  /** The service route answering how many things in the view wait on the person. */
  attentionUrl?: string;
  /** `"workspace"`: no page header or inset, agent terminal held collapsed. */
  layout?: StudioViewLayout;
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
    const selected = page.companion
      ? (companions.find((entry) => entry.path === page.companion!.path) ?? null)
      : null;
    const chat = context.studio.modePolicy.chat;
    return {
      companions,
      // Only the chat needs the followed path.
      selected:
        selected && chat
          ? withRealPath(selected, context.studio.physicalPath(selected.path))
          : selected,
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
      chat,
      addsCompanions: context.studio.addsCompanions(),
      pluginViews: context.studio.services().flatMap((service) =>
        service.views.flatMap((view) =>
          view.moduleUrl
            ? [
                {
                  service: service.id,
                  view: view.id,
                  label: view.label,
                  ...(view.description ? { description: view.description } : {}),
                  moduleUrl: view.moduleUrl,
                  ...(view.attentionUrl ? { attentionUrl: view.attentionUrl } : {}),
                  ...(view.layout ? { layout: view.layout } : {}),
                },
              ]
            : [],
        ),
      ),
      terminal: page.terminal
        ? {
            pinned: page.terminal.pinned,
            target: page.terminal.target,
            agents: page.terminal.agents,
          }
        : null,
    };
  });
