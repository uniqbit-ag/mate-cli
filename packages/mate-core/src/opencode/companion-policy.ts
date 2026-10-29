import fs from "node:fs";
import path from "node:path";

import { persistedCompanionGitStalenessLines } from "../runtime/companion-sync";
import { resolveCompanionRuntime, type CompanionRuntimeContext } from "../runtime/env";
import { projectionFreshness, projectionStalenessLines } from "../runtime/freshness";
import { readSessionNotes } from "./session-notes";

export type CompanionContext = CompanionRuntimeContext & {
  agentsMd: string;
  /**
   * Operator-facing session state: a stale projection, and an unfinished
   * companion Git synchronization. Never reaches a model payload — the TUI is
   * its only reader.
   */
  stalenessLines: string[];
};

/**
 * Resolves its own companion — launch environment first, Projection Root
 * second — rather than taking one from the caller. `AGENTS.md` follows the
 * resolved companion so the two cannot name different repositories.
 */
export function readContext(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): CompanionContext {
  const { context, projection } = resolveCompanionRuntime(env, cwd);

  let agentsMd = "";
  if (context.companionPath) {
    const agentsMdPath = path.join(context.companionPath, "AGENTS.md");
    try {
      if (fs.existsSync(agentsMdPath)) {
        agentsMd = fs.readFileSync(agentsMdPath, "utf8");
      }
    } catch {
      // Ignore read errors; AGENTS.md is optional
    }
  }

  return { ...context, agentsMd, stalenessLines: stalenessLinesFor(context, projection) };
}

function stalenessLinesFor(
  context: CompanionRuntimeContext,
  projection: ReturnType<typeof resolveCompanionRuntime>["projection"],
): string[] {
  if (!projection) return [];
  /** A sync note repeats the persisted Git line it came from. */
  return [
    ...new Set([
      ...projectionStalenessLines(projection, projectionFreshness(projection)),
      ...persistedCompanionGitStalenessLines(context.companionPath, undefined, "opencode"),
      ...(context.repositoryPath ? readSessionNotes(context.repositoryPath) : []),
    ]),
  ];
}

/** The session state alone, cheap enough for the TUI to poll: no `AGENTS.md` read, no Git. */
export function readStalenessLines(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string[] {
  const { context, projection } = resolveCompanionRuntime(env, cwd);
  return stalenessLinesFor(context, projection);
}
