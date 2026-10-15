import { resolveSecretPolicy } from "../../../runtime/policy";
import { ensureGraphifySecretExclusion, pruneGraphifySecrets } from "./graphify-secrets";

/**
 * The secret gate behind the `graphify` wrapper, for extractions an agent
 * runs without `mate cap graphify`. Never fails the run: problems are
 * warnings on stderr and the exit code is always 0.
 *
 * - `pre <companion> <repo>` rewrites the `.graphifyignore` region and prints
 *   the secret patterns, one per line, for the wrapper to pass as `--exclude`.
 * - `post <companion> <graphify-out>` prunes secrets from the output.
 */
export async function runGraphifyGate(argv: string[]): Promise<number> {
  const [mode, companionPath, target] = argv;
  if (!companionPath || !target) return 0;
  const policy = resolveSecretPolicy(companionPath);
  if (mode === "pre") {
    try {
      await ensureGraphifySecretExclusion(target, policy);
    } catch (error) {
      process.stderr.write(`graphify: warning: ${(error as Error).message}\n`);
    }
    if (policy.guardrails)
      process.stdout.write(policy.deny.map((pattern) => `${pattern}\n`).join(""));
  } else if (mode === "post") {
    for (const note of await pruneGraphifySecrets(target, policy)) {
      process.stderr.write(`graphify: ${note}\n`);
    }
  }
  return 0;
}
