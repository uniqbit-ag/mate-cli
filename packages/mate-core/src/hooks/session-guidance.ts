// Deliver the companion guidance to a Claude session Mate did not launch.
import { readLayerGuidanceSync } from "../runtime/audience-layer";
import { resolveProjection } from "../runtime/projection";
import { buildProjectedGuidance } from "../runtime/projected-guidance";
import { wrappedAudienceLayer } from "../runtime/session-audience";
import type { HookEnv } from "./validate-artifact-path";

export interface GuidanceOutcome {
  exitCode: number;
  stdout: string;
}

/**
 * The guidance of the audience this checkout is wrapped for, from its layer.
 * The wrap is the only source: an inherited `MATE_AUDIENCE` selects nothing.
 */
function wrappedAudienceGuidance(cwd: string): string {
  const projection = resolveProjection(cwd);
  if (!projection) return "";
  const layer = wrappedAudienceLayer(projection.companionPath, projection.repoRoot);
  return layer ? readLayerGuidanceSync(layer, "CLAUDE.md") : "";
}

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
export function buildSessionGuidance(env: HookEnv, cwd: string = process.cwd()): GuidanceOutcome {
  const companionGuidance = buildProjectedGuidance(env, cwd);
  if (!companionGuidance) return { exitCode: 0, stdout: "" };
  const layer = wrappedAudienceGuidance(cwd);
  const guidance = layer ? `${companionGuidance}\n\n${layer}` : companionGuidance;

  return {
    exitCode: 0,
    stdout: `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: guidance,
      },
    })}\n`,
  };
}

// Plugin-shim entry.
export function run(): number {
  const outcome = buildSessionGuidance(process.env);
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  return outcome.exitCode;
}
