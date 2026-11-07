import { randomUUID } from "node:crypto";

import { type FactoryClient, factoryClient } from "../../../lib/factory/client";
import type { AttachStart } from "../../../lib/factory/attach-client";
import { prepareWorkset } from "../../../lib/factory/prepare";
import { writeWorkset } from "../../../lib/workset/record";
import { effectiveLaunchCompanion } from "./terminal-launch";
import type { StudioInventory } from "./inventory";
import type { WorksetSessionResolution } from "./terminal";
import { NO_CREDENTIAL } from "../../../lib/factory/credential-store";

/**
 * Resolves a Workset session start: everything is checked and prepared on the server
 * (credential, record, container, link, first turn), and the terminal is handed only
 * the attach helper's argv. The browser names the Workset and nothing else.
 */

export interface WorksetResolverOptions {
  collectInventory: () => Promise<StudioInventory>;
  launchCompanion?: string | null;
  /** The Mate invocation prefix the attach helper runs under. */
  mateCommand: string[];
  client?: () => FactoryClient | null;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Skip the companion's Git synchronization in the session, as Studio's own launches do. */
  noGit?: boolean;
  /**
   * While a person has control of the Workset's Outcome: the factory's Claude session the
   * native session resumes. `null` lets the session start as it otherwise would.
   */
  takenOver?: (id: string) => Promise<{ claudeSession: string | null } | null>;
}

/** Claude Code's project directory for a working directory: every non-alphanumeric becomes `-`. */
const HAS_CONVERSATION =
  'd=$(printf %s "$PWD" | sed "s/[^A-Za-z0-9-]/-/g"); test -d "$HOME/.claude/projects/$d"';

/**
 * Interactive Claude shows its first-run login screen until `~/.claude.json` says onboarding is
 * done; the factory's headless turns never set it. Merged in place, every other key kept.
 */
const ONBOARDED = [
  "node",
  "-e",
  [
    'const fs = require("fs");',
    "const file = `${process.env.HOME}/.claude.json`;",
    "let config = {};",
    'try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}',
    "if (config.hasCompletedOnboarding !== true) {",
    "  config.hasCompletedOnboarding = true;",
    "  fs.writeFileSync(`${file}.tmp`, JSON.stringify(config, null, 2));",
    "  fs.renameSync(`${file}.tmp`, file);",
    "}",
  ].join("\n"),
];

export function createWorksetResolver(
  options: WorksetResolverOptions,
): (id: string, digest: string | null, session: string) => Promise<WorksetSessionResolution> {
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
        return { reason: NO_CREDENTIAL };
      }
      const { record, warnings } = await prepareWorkset(client, companion.path, id, options.env);
      const onboarded = await client.exec({ id, command: ONBOARDED });
      if (onboarded.status !== 0)
        return { reason: "the Workset's Claude settings could not be prepared" };

      const takenOver = (await options.takenOver?.(id)) ?? null;
      if (takenOver && !takenOver.claudeSession) {
        return { reason: "this Outcome has no factory conversation to take over" };
      }
      const resumeSession = takenOver?.claudeSession;
      let start: AttachStart;
      if (resumeSession) {
        start = "resume";
      } else if (
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
          ...(resumeSession ? ["--resume-session", resumeSession] : []),
          ...(options.noGit ? ["--no-git"] : []),
        ],
        // The terminal needs CRLF: a bare LF moves down without returning.
        ...(warnings.length > 0
          ? { notice: warnings.join("\n").replaceAll(/\r?\n/g, "\r\n") }
          : {}),
      };
    } catch (error) {
      return { reason: (error as Error).message };
    }
  };
}

export const newSessionId = () => randomUUID();
