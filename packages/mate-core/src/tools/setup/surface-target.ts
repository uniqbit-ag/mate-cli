import type { ProjectionTarget, SetupContext } from "./plugin";

/**
 * The projection target of a reconcile pass, resolved once. A `working` pass
 * without a Working Repository in scope refuses rather than falling back to the
 * companion: writing the other root is the one outcome the caller cannot detect.
 */
export function projectionTarget(ctx: SetupContext): ProjectionTarget {
  const target = ctx.target ?? "companion";
  if (target === "working" && !ctx.repoPath) {
    throw new Error(
      "a working-target reconcile needs a Working Repository in scope; none was supplied",
    );
  }
  return target;
}

/**
 * The root a Runtime Surface writes into. Defined for the companion target
 * only: a working-target pass renders its documents for the Projection Root to
 * place, so no Runtime Surface ever computes a path inside a Working Repository.
 */
export function surfaceRoot(ctx: SetupContext): string {
  if (projectionTarget(ctx) === "working") {
    throw new Error("a working-target reconcile renders its documents; it writes no surface root");
  }
  return ctx.companionPath;
}
