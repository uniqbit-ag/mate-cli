import { buildOpenCodeGuidance } from "../runtime/companion-guidance";
import { MATE_ENV } from "../runtime/env-names";
import { parseGuidanceContent, type MateGuidanceFile } from "../runtime/guidance";
import { resolveSessionWithoutBorrowing } from "../runtime/session-resolution";

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
 * the session and from a projection Session Resolution trusts otherwise.
 *
 * The projected branch needs nothing but the enabled Capability names: the
 * payload carries `$MATE_*` placeholders that the plugin materializes from its
 * own resolved context, so no path is resolved here. Reading the names live
 * means a Capability toggled after a wrap changes the guidance on the next
 * session with no re-wrap.
 *
 * `env` is the launch environment the plugin decided to trust: inherited
 * `MATE_*` variables arrive as `{}` (`pluginLaunchEnvironment`), so a launch
 * without a payload builds none. A present but malformed payload stays a hard
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

  const session = resolveSessionWithoutBorrowing(env, cwd);
  if (session.kind !== "projection") return { guidance: null, errors: [] };

  const policy = session.policy();
  const guidance = buildOpenCodeGuidance(
    policy.enabledCapabilities.map((name) => ({ name })),
    { secretGuardrails: policy.secrets.guardrails },
  );
  return { guidance: guidance.errors.length > 0 ? null : guidance, errors: guidance.errors };
}
