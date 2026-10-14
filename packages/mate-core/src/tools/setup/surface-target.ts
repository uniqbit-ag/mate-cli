import path from "node:path";

import { audienceLayerDir } from "../../runtime/audience-layer";
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
  if (target === "audience-layer" && !ctx.audience) {
    throw new Error("an audience-layer reconcile needs an audience; none was supplied");
  }
  return target;
}

/**
 * The Working Repository a rendered document is addressed by, resolved so a
 * symlinked working directory still matches what the runtime reports. Every
 * document a reconcile pass renders is for a Working Repository, so a pass with
 * none in scope refuses here rather than resolving an absent path: `path.resolve`
 * answers the current working directory for an empty one, and a document keyed
 * by wherever the process happened to start would file a Runtime Surface's MCP
 * servers under a stranger's project in the user's global Claude config — a
 * write no caller asked for and none would notice.
 */
export function projectionRepoRoot(ctx: SetupContext): string {
  const target = projectionTarget(ctx);
  if (!ctx.repoPath) {
    throw new Error(
      `a ${target}-target render needs a Working Repository in scope to address its documents by; none was supplied`,
    );
  }
  return path.resolve(ctx.repoPath);
}

/**
 * The root a Runtime Surface writes into: the companion, or one audience's
 * layer outside every repository. Never a Working Repository: a working-target
 * pass renders its documents for the Projection Root to place, so no Runtime
 * Surface ever computes a path inside one.
 */
export function surfaceRoot(ctx: SetupContext): string {
  const target = projectionTarget(ctx);
  if (target === "working") {
    throw new Error("a working-target reconcile renders its documents; it writes no surface root");
  }
  if (target === "audience-layer") {
    return ctx.layerRoot ?? audienceLayerDir(ctx.companionPath, ctx.audience!);
  }
  return ctx.companionPath;
}
