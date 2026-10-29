import fs from "node:fs";
import path from "node:path";

import { persistedCompanionGitStalenessLines } from "../runtime/companion-sync";
import { MATE_ENV } from "../runtime/env-names";
import { FRAMEWORK_NAME } from "../runtime/framework";
import { projectionFreshness, projectionStalenessLines } from "../runtime/freshness";
import { resolveSession, type ResolvedSession } from "../runtime/session-resolution";
import { readSessionNotes } from "./session-notes";

/**
 * The OpenCode plugin's view of its session. Empty strings and `false` flags
 * when no companion resolves; `session` is the answer they came from.
 */
export type CompanionContext = {
  frameworkName: string;
  companionPath: string;
  repositoryPath: string;
  repositoryId: string;
  policyJson: string;
  graphifyEnabled: boolean;
  gitAutoModeEnabled: boolean;
  reactDoctorEnabled: boolean;
  session: ResolvedSession;
  agentsMd: string;
  /**
   * Operator-facing session state: a stale projection, and an unfinished
   * companion Git synchronization. Never reaches a model payload — the TUI is
   * its only reader.
   */
  stalenessLines: string[];
};

type SessionFields = Omit<CompanionContext, "agentsMd" | "stalenessLines">;

function sessionFields(session: ResolvedSession, env: Record<string, string | undefined>) {
  const frameworkName =
    (session.kind === "launch" ? env[MATE_ENV.frameworkName] : undefined) ?? FRAMEWORK_NAME;
  if (session.kind === "none") {
    return {
      frameworkName,
      companionPath: "",
      repositoryPath: "",
      repositoryId: "",
      policyJson: "{}",
      graphifyEnabled: false,
      gitAutoModeEnabled: false,
      reactDoctorEnabled: false,
      session,
    } satisfies SessionFields;
  }
  const flags = session.flags();
  return {
    frameworkName,
    companionPath: session.companionPath,
    repositoryPath: session.checkoutRoot,
    repositoryId: session.repositoryId,
    policyJson: session.policyJson(),
    graphifyEnabled: flags.graphify,
    gitAutoModeEnabled: flags.gitAutoMode,
    reactDoctorEnabled: flags.reactDoctor,
    session,
  } satisfies SessionFields;
}

/**
 * Resolves its own companion through Session Resolution rather than taking one
 * from the caller. `AGENTS.md` follows the resolved companion so the two
 * cannot name different repositories.
 */
export function readContext(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): CompanionContext {
  const session = resolveSession(env, cwd);
  const fields = sessionFields(session, env);

  let agentsMd = "";
  if (fields.companionPath) {
    const agentsMdPath = path.join(fields.companionPath, "AGENTS.md");
    try {
      if (fs.existsSync(agentsMdPath)) {
        agentsMd = fs.readFileSync(agentsMdPath, "utf8");
      }
    } catch {
      // Ignore read errors; AGENTS.md is optional
    }
  }

  return { ...fields, agentsMd, stalenessLines: stalenessLinesFor(session) };
}

function stalenessLinesFor(session: ResolvedSession): string[] {
  if (session.kind !== "projection") return [];
  /** A sync note repeats the persisted Git line it came from. */
  return [
    ...new Set([
      ...projectionStalenessLines(session.projection, projectionFreshness(session.projection)),
      ...persistedCompanionGitStalenessLines(session.companionPath, undefined, "opencode"),
      ...readSessionNotes(session.checkoutRoot),
    ]),
  ];
}

/** The session state alone, cheap enough for the TUI to poll: no `AGENTS.md` read, no Git. */
export function readStalenessLines(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string[] {
  return stalenessLinesFor(resolveSession(env, cwd));
}
