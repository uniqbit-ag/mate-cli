import { buildOpenCodeGuidance } from "../runtime/companion-guidance";
import { MATE_ENV } from "../runtime/env-names";
import { parseGuidanceContent, type MateGuidanceFile } from "../runtime/guidance";
import { readCompanionPolicy } from "../runtime/policy";
import { resolveProjection } from "../runtime/projection";

/**
 * `null` guidance with no errors is the inert case — no companion resolves, so
 * the plugin contributes nothing. Errors are startup failures: a payload that
 * does not parse, or projected guidance that cannot be built.
 */
export interface OpenCodeGuidanceResolution {
  guidance: MateGuidanceFile | null;
  errors: string[];
}

/**
 * The OpenCode guidance payload, from the launch environment when Mate started
 * the session and from the Projection Root otherwise — the same env-first,
 * projection-second contract `readCompanionRuntimeContext` already follows.
 *
 * The projected branch needs nothing but the enabled Capability names: the
 * payload carries `$MATE_*` placeholders that the plugin materializes from its
 * own resolved context, so no path is resolved here. Reading the names live
 * means a Capability toggled after a wrap changes the guidance on the next
 * session with no re-wrap.
 *
 * Without a payload the projection decides, whatever other `MATE_*` variables
 * `env` carries: those are inherited by every descendant of a Mate session and
 * do not mark a managed launch. A present but malformed payload stays a hard
 * error.
 */
export function resolveOpenCodeGuidance(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): OpenCodeGuidanceResolution {
  const raw = env[MATE_ENV.guidanceJson];
  if (raw?.trim()) {
    const { guidance, errors } = parseGuidanceContent(raw);
    return { guidance: errors.length > 0 ? null : guidance, errors };
  }

  const projection = resolveProjection(cwd);
  if (!projection) return { guidance: null, errors: [] };

  const policy = readCompanionPolicy(projection.companionPath);
  const guidance = buildOpenCodeGuidance(
    policy.enabledCapabilities.map((name) => ({ name })),
    { secretGuardrails: policy.secrets.guardrails },
  );
  return { guidance: guidance.errors.length > 0 ? null : guidance, errors: guidance.errors };
}
