import { buildCompanionGuidance } from "./companion-guidance";
import type { ResolvedSession } from "./session-resolution";

/**
 * The companion guidance for an Unmanaged Session, built from the Projection
 * Root instead of from a launch.
 *
 * Guidance was the one companion concept with no reader form: it is built from
 * an `AdapterContext`, which exists only inside a `LaunchAdapter`, so it could
 * not cross into a session Mate did not start. Every field it needs is
 * available without one — paths from the projection, predicates read live from
 * the companion — which is what this composes.
 *
 * Reading the predicates live rather than projecting the rendered text is what
 * makes a Capability toggled after a wrap change the guidance with no re-wrap.
 * A rendered string in the Projection Root would be a snapshot, and rule 2 —
 * paths only, never predicates — exists to keep exactly that out of it.
 *
 * Returns null unless the session resolved from a trusted projection: a launch
 * already injects the guidance through its own channel, and rule 1 says the
 * environment wins. That is what lets the same declaration be loaded by both a
 * plugin and a projected document without emitting twice.
 */
export function buildProjectedGuidance(session: ResolvedSession): string | null {
  if (session.kind !== "projection") return null;

  const policy = session.policy();
  return buildCompanionGuidance(
    {
      companionPath: session.companionPath,
      repository: { id: session.repositoryId, path: session.checkoutRoot },
      capabilities: policy.enabledCapabilities.map((name) => ({ name })),
      secretGuardrails: policy.secrets.guardrails,
    },
    /** The projected path, not the running install's: a wrap may be another mate's. */
    { wrapperBinPath: session.projection.wrapperBinPath },
  );
}
