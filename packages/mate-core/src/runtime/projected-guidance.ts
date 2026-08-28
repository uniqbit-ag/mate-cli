import { buildCompanionGuidance } from "./companion-guidance";
import { hasLaunchEnvironment } from "./env";
import { readCompanionPolicy } from "./policy";
import { resolveProjection } from "./projection";

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
 * Returns null for a managed session: the launch already injects the guidance
 * through its own channel, and rule 1 says the environment wins. That is what
 * lets the same declaration be loaded by both a plugin and a projected
 * document without emitting twice.
 */
export function buildProjectedGuidance(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string | null {
  if (hasLaunchEnvironment(env)) return null;

  const projection = resolveProjection(cwd);
  if (!projection) return null;

  const policy = readCompanionPolicy(projection.companionPath);
  return buildCompanionGuidance(
    {
      companionPath: projection.companionPath,
      repository: { id: projection.repositoryId, path: projection.repositoryPath },
      capabilities: policy.enabledCapabilities.map((name) => ({ name })),
    },
    /** The projected path, not the running install's: a wrap may be another mate's. */
    { wrapperBinPath: projection.wrapperBinPath },
  );
}
