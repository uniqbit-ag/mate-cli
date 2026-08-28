import { buildOpenCodeGuidance } from "../runtime/companion-guidance";
import { MATE_ENV } from "../runtime/env-names";
import { hasLaunchEnvironment } from "../runtime/env";
import { parseGuidanceContent, type MateGuidanceFile } from "../runtime/guidance";
import { readCompanionPolicy } from "../runtime/policy";
import { resolveProjection } from "../runtime/projection";

/**
 * `null` guidance with no errors is the inert case — no companion resolves, so
 * the plugin contributes nothing. Errors are startup failures: a managed launch
 * that failed to inject its payload is broken and must say so.
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
 * A missing payload while a launch environment *is* present stays a hard error.
 * That combination means a managed launch failed to inject, which the projection
 * must not paper over.
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

  if (hasLaunchEnvironment(env)) {
    return {
      guidance: null,
      errors: [`missing ${MATE_ENV.guidanceJson} in the launch environment`],
    };
  }

  const projection = resolveProjection(cwd);
  if (!projection) return { guidance: null, errors: [] };

  const policy = readCompanionPolicy(projection.companionPath);
  const guidance = buildOpenCodeGuidance(policy.enabledCapabilities.map((name) => ({ name })));
  return { guidance: guidance.errors.length > 0 ? null : guidance, errors: guidance.errors };
}
