/**
 * Show the active Mate companion paths in Claude Code, and repair the
 * companion's Git state before the session reads it.
 */
import { errorMessage } from "../runtime/error-message";
import { unmanagedClaudeDelivery } from "../runtime/claude-delivery-plan";
import {
  syncCompanionUnattended,
  unattendedSyncStalenessLines,
  type UnattendedSyncOptions,
} from "../runtime/companion-sync";
import { FRAMEWORK_NAME } from "../runtime/framework";
import { projectionFreshness, projectionStalenessLines } from "../runtime/freshness";
import { mateVersion } from "../runtime/install";
import { PROJECTED_FLAG } from "../runtime/projected-flag";
import { resolveSession, sessionRefusalNotice } from "../runtime/session-resolution";
import { hookFolder, hookOutcome, runHook, type HookEnv, type HookOutcome } from "./hook-io";

/**
 * Resolves in-process through Session Resolution — no subprocess. One of the
 * surfaces where a drifted wrap becomes visible, so staleness is reported,
 * never suppressed; and the Claude surface that names a refused projection,
 * to the operator only.
 */
export async function buildBanner(
  env: HookEnv,
  cwd: string = process.cwd(),
  argv: readonly string[] = [],
  syncOptions: UnattendedSyncOptions = {},
): Promise<HookOutcome> {
  const session = resolveSession(env, cwd);
  if (session.kind === "none") {
    return hookOutcome(
      session.refusal ? { systemMessage: sessionRefusalNotice(session.refusal) } : null,
    );
  }
  if (argv.includes(PROJECTED_FLAG) && session.kind === "launch") return hookOutcome(null);
  if (!session.checkoutRoot || !session.companionPath) return hookOutcome(null);

  /**
   * Repaired before the session reads the companion, so its first reads are
   * current. The companion can still move later — a plain OpenCode session's
   * background sync fast-forwards it — but a fast-forward never overwrites a
   * local edit, so the worst case is a stale read of an upstream change. Only
   * tries the companion lock: a held lock means another sync is already on it,
   * and a session start must not stall behind it. A launch never owns it, so a
   * Managed Session pays nothing at all — not the freshness read, not the
   * policy read; and the consent gate is the operation's own. Who owns it
   * otherwise is the delivery plan's call, so a session start fetches once.
   */
  const projection = session.kind === "projection" ? session.projection : undefined;
  const ownsGitSync =
    projection !== undefined && unmanagedClaudeDelivery(projection.repoRoot).gitSync === "banner";
  const gitNotes = ownsGitSync
    ? unattendedSyncStalenessLines(
        await syncCompanionUnattended(session.companionPath, { lock: "try", ...syncOptions }),
      )
    : [];

  const lines = [
    `mate v${env.MATE_VERSION || mateVersion()}`,
    `  repo:     ${session.checkoutRoot}`,
    `  mate: ${session.companionPath}`,
  ];
  if (projection) {
    for (const note of projectionStalenessLines(projection, projectionFreshness(projection))) {
      lines.push(`  ${note}`);
    }
  }
  /** `systemMessage` only: the model must never be told to run the command. */
  for (const note of gitNotes) lines.push(`  ${note}`);

  return hookOutcome({ systemMessage: lines.join("\n") });
}

/** Plugin-shim entry; exits zero even when the banner fails. */
export function run(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  return runHook(
    (input) => buildBanner(process.env, hookFolder(input, process.env, process.cwd()), argv),
    (error) =>
      hookOutcome({
        systemMessage: `${FRAMEWORK_NAME}: session banner failed: ${errorMessage(error)}`,
      }),
  );
}
