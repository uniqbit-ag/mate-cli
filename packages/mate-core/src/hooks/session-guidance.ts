// Deliver the companion guidance to a Claude session Mate did not launch.
import { guardLaunchEnvironment } from "../runtime/launch-env-guard";
import { buildProjectedGuidance } from "../runtime/projected-guidance";
import { hookFolder, hookOutcome, runHook, type HookEnv, type HookOutcome } from "./hook-io";

/**
 * `SessionStart.additionalContext` is the file-based form of the managed
 * launch's `--append-system-prompt`: a settings document can declare a hook,
 * and there is no settings key for the flag. The two never both fire —
 * `buildProjectedGuidance` yields nothing when a launch environment is present
 * — so the plugin may carry this group alongside the projected copy.
 *
 * Emits nothing rather than a note when no companion resolves: an unwrapped
 * repository must read exactly as it did before the hook existed.
 */
export function buildSessionGuidance(env: HookEnv, cwd: string = process.cwd()): HookOutcome {
  const guidance = buildProjectedGuidance(env, cwd);
  if (!guidance) return hookOutcome(null);

  return hookOutcome({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: guidance,
    },
  });
}

/** Plugin-shim entry; emits nothing when it fails, as when no companion resolves. */
export function run(): Promise<number> {
  // A background session can inherit another launch's environment from Claude's daemon.
  guardLaunchEnvironment(process.env, process.cwd());
  return runHook(
    (input) => buildSessionGuidance(process.env, hookFolder(input, process.env, process.cwd())),
    () => hookOutcome(null),
  );
}
