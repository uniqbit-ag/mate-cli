import path from "node:path";

import { resolveSecretPolicy } from "../../../../runtime/policy";
import { isSecretFile } from "../../../../runtime/secret-patterns";
import { listFiles, scanFiles, type SecretFinding } from "../../../../runtime/secret-scan";

/** Rule id reported for a staged path that is itself a secret file. */
export const SECRET_FILE_RULE_ID = "mate/secret-file";

export type PublicationSecretScan =
  | { skipped: true }
  | { skipped: false; findings: SecretFinding[] };

/**
 * Scans exactly what a publication would stage: every file under the commit
 * paths that exists on disk (a deleted path has nothing to leak). A staged
 * secret file counts as a finding of its own. Paths are reported relative to
 * the companion; values never leave this function. Throws when the scanner
 * fails, which the engine treats like a finding.
 */
export async function scanPublication(
  companionPath: string,
  commitPaths: readonly string[],
): Promise<PublicationSecretScan> {
  const policy = resolveSecretPolicy(companionPath);
  if (!policy.guardrails) return { skipped: true };

  const files = (
    await Promise.all(
      commitPaths.map((commitPath) => listFiles(path.join(companionPath, commitPath))),
    )
  ).flat();
  const relative = (file: string) => path.relative(companionPath, file).split(path.sep).join("/");
  const secretFiles: SecretFinding[] = files
    .map(relative)
    .filter((file) => isSecretFile(file, policy))
    .map((file) => ({ path: file, line: 0, ruleId: SECRET_FILE_RULE_ID }));
  const contentFindings = (await scanFiles(files)).map((finding) => ({
    ...finding,
    path: relative(finding.path),
  }));
  return { skipped: false, findings: [...secretFiles, ...contentFindings] };
}
