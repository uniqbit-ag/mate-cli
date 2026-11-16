import { randomUUID } from "node:crypto";

import { type FactoryClient, factoryClient } from "../../../lib/factory/client";
import { type AttachStart, prepareCommand } from "../../../lib/factory/attach-client";
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
 * done, and asks to trust the folder until it lists it as accepted; the factory's headless turns
 * set neither. Run by exec in the Workset's worktree, so the trusted folder is that worktree and
 * nothing the browser names. Merged in place, every other key kept.
 */
const CLAUDE_SETTINGS = [
  "node",
  "-e",
  [
    'const fs = require("fs");',
    "const file = `${process.env.HOME}/.claude.json`;",
    "let config = {};",
    "let text = '';",
    // A file that cannot be read is reported: nothing could be written there either.
    'try { text = fs.readFileSync(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") { console.error(`${file} is unreadable: ${error.message}`); process.exit(1); } }',
    "const isObject = (value) => value !== null && typeof value === 'object';",
    // A blank file is empty config. A damaged one, as a write cut short leaves it, is kept beside it and replaced, so no session is blocked on a file nobody can reach.
    "if (text.trim()) { let parsed; try { parsed = JSON.parse(text); } catch {} if (isObject(parsed) && !Array.isArray(parsed)) config = parsed; else { const kept = `${file}.damaged-${Date.now()}`; fs.copyFileSync(file, kept); console.error(`${file} was no JSON object; kept as ${kept}`); } }",
    "const dir = process.cwd();",
    "const projects = isObject(config.projects) ? config.projects : {};",
    "const project = isObject(projects[dir]) ? projects[dir] : {};",
    "if (config.hasCompletedOnboarding !== true || project.hasTrustDialogAccepted !== true) {",
    "  project.hasTrustDialogAccepted = true;",
    "  config.hasCompletedOnboarding = true;",
    "  config.projects = { ...projects, [dir]: project };",
    "  fs.writeFileSync(`${file}.tmp`, JSON.stringify(config, null, 2));",
    "  fs.renameSync(`${file}.tmp`, file);",
    "}",
  ].join("\n"),
];

/** The first line of what a failed command said, for the dialog; the full output stays in the broker's log. */
function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function failedStep(step: string, output: { stderr: string; stdout: string }): { reason: string } {
  const detail = firstLine(output.stderr || output.stdout);
  return { reason: `${step}${detail ? `: ${detail}` : ""}` };
}

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
      const settings = await client.exec({ id, command: CLAUDE_SETTINGS });
      if (settings.status !== 0) {
        return failedStep("the Workset's Claude settings could not be prepared", settings);
      }

      const takenOver = (await options.takenOver?.(id)) ?? null;
      if (takenOver && !takenOver.claudeSession) {
        return { reason: "this Outcome has no factory conversation to take over" };
      }
      const resumeSession = takenOver?.claudeSession;
      // The wrap and the index run here, their output captured, so the terminal opens on Claude.
      const prepared = await client.exec({
        id,
        command: prepareCommand(options.noGit ? { noGit: true } : {}),
      });
      if (prepared.status !== 0) {
        return failedStep("the Workset's session could not be prepared", prepared);
      }
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
