import { physicalPath } from "../../runtime/physical-path";
import { servingClaudeWrapRoot } from "../../runtime/serving-claude-wrap";
import { readWrapStateSync } from "../../runtime/wrap-state";
import { adoptNewCheckout } from "./checkout-adoption";
import { readCompanionConfig } from "./config-store";
import { findRepoLocalLinkedRepository } from "./repository-link";
import type { FrameworkConfig, LinkedRepository } from "./types";
import { runWrapPass, type WrapPassResult } from "./wrap-pass";

export interface ServingClaudeWrap {
  repository: LinkedRepository;
  result: WrapPassResult;
}

export const servingClaudeWrapDeps = {
  readCompanionConfig,
  runWrapPass,
  adoptNewCheckout: (folder: string) => adoptNewCheckout(folder),
};

/**
 * Reconciles the Claude wrap of the Checkout that serves `repository` when
 * that is another Checkout (design Decision 12), before `repository`'s own:
 * an existing one always, a missing one only with `create`, which adopts the
 * serving Checkout when it has no link of its own. Null when `repository`
 * serves itself, or no wrap is there to reconcile. Runs under the caller's
 * companion lock.
 */
export async function reconcileServingClaudeWrap(
  companionPath: string,
  repository: LinkedRepository,
  options: { create: boolean; config?: FrameworkConfig },
): Promise<ServingClaudeWrap | null> {
  const serving = servingClaudeWrapRoot(repository.path);
  if (physicalPath(serving) === physicalPath(repository.path)) return null;
  if (!options.create && !readWrapStateSync(serving).runtimes.has("claude")) return null;
  const config = options.config ?? (await servingClaudeWrapDeps.readCompanionConfig(companionPath));
  if (!config.allowedAgents.includes("claude")) return null;

  const servingRepository = (await findRepoLocalLinkedRepository(serving)) ??
    (options.create ? await servingClaudeWrapDeps.adoptNewCheckout(serving) : null) ?? {
      id: repository.id,
      path: serving,
    };
  const result = await servingClaudeWrapDeps.runWrapPass(companionPath, servingRepository, {
    runtimes: ["claude"],
    config,
  });
  return { repository: servingRepository, result };
}
