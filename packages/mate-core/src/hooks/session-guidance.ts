// Deliver the companion guidance to a Claude session Mate did not launch.
import { buildProjectedGuidance } from "../runtime/projected-guidance";
import { resolveSession } from "../runtime/session-resolution";
import { hookOutcome, type HookEnv, type HookOutcome } from "./hook-io";

/**
 * `SessionStart.additionalContext` is the file-based form of the managed
 * launch's `--append-system-prompt`: a settings document can declare a hook,
 * and there is no settings key for the flag. The two never both fire —
 * `buildProjectedGuidance` yields nothing unless the session resolved from a
 * projection — so the plugin may carry this group alongside the projected copy.
 *
 * Emits nothing rather than a note when no companion resolves, a refused
 * projection included (the banner tells the operator): an unwrapped
 * repository must read exactly as it did before the hook existed.
 */
export function buildSessionGuidance(env: HookEnv, cwd: string = process.cwd()): HookOutcome {
  const guidance = buildProjectedGuidance(resolveSession(env, cwd));
  if (!guidance) return hookOutcome(null);

  return hookOutcome({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: guidance,
    },
  });
}

// Plugin-shim entry.
export function run(): number {
  const outcome = buildSessionGuidance(process.env);
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  return outcome.exitCode;
}
