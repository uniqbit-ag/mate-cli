import { randomUUID } from "node:crypto";

import { type FactoryClient, factoryClient } from "../../../lib/factory/client";
import type { AttachStart } from "../../../lib/factory/attach-client";
import { prepareWorkset } from "../../../lib/factory/prepare";
import { writeWorkset } from "../../../lib/workset/record";
import { effectiveLaunchCompanion } from "./terminal-launch";
import type { StudioInventory } from "./inventory";

/**
 * Resolves a Workset session start: everything is checked and prepared on the server
 * (credential, record, container, link, first turn), and the terminal is handed only
 * the attach helper's argv. The browser names the Workset and nothing else.
 */

export type WorksetLaunchResolution =
  | { companionPath: string; workset: { id: string; title: string }; argv: string[] }
  | { reason: string };

export interface WorksetResolverOptions {
  collectInventory: () => Promise<StudioInventory>;
  launchCompanion?: string | null;
  /** The Mate invocation prefix the attach helper runs under. */
  mateCommand: string[];
  client?: () => FactoryClient | null;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** Claude Code's project directory for a working directory: every non-alphanumeric becomes `-`. */
const HAS_CONVERSATION =
  'd=$(printf %s "$PWD" | sed "s/[^A-Za-z0-9-]/-/g"); test -d "$HOME/.claude/projects/$d"';

export function createWorksetResolver(
  options: WorksetResolverOptions,
): (id: string, digest: string | null, session: string) => Promise<WorksetLaunchResolution> {
  const clientFor = options.client ?? (() => factoryClient(options.env?.MATE_FACTORY_BROKER));
  const now = options.now ?? (() => new Date());
  return async (id, digest, session) => {
    const client = clientFor();
    if (!client) return { reason: "Workset sessions need the appliance's factory mode" };
    const companion = await effectiveLaunchCompanion(
      await options.collectInventory(),
      options.launchCompanion,
      digest,
    );
    if (!companion) return { reason: "no registered companion is selected" };
    try {
      if ((await client.info()).credential === null) {
        return {
          reason:
            "no Workset agent credential is configured; set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY",
        };
      }
      const record = await prepareWorkset(client, companion.path, id, options.env);

      let start: AttachStart;
      if (
        record.changes.length === 0 &&
        record.stage === "explore" &&
        !record.extra.exploreStartedAt
      ) {
        start = "explore";
        await writeWorkset(companion.path, {
          ...record,
          extra: { ...record.extra, exploreStartedAt: now().toISOString() },
        });
      } else {
        const conversation = await client.exec({ id, command: ["sh", "-c", HAS_CONVERSATION] });
        start = conversation.status === 0 ? "continue" : "clarify";
      }
      return {
        companionPath: companion.path,
        workset: { id, title: record.title },
        argv: [
          ...options.mateCommand,
          "factory",
          "attach",
          id,
          "--session",
          session,
          "--start",
          start,
          "--companion",
          companion.path,
        ],
      };
    } catch (error) {
      return { reason: (error as Error).message };
    }
  };
}

export const newSessionId = () => randomUUID();
