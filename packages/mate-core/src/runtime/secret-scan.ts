import fs from "node:fs/promises";
import path from "node:path";

import type { lintSource as LintSourceFn } from "@secretlint/core";
import type { SecretLintCoreConfig } from "@secretlint/types";

/** One secretlint finding. Deliberately carries no message: messages quote the value. */
export interface SecretFinding {
  path: string;
  line: number;
  ruleId: string;
}

type LintSource = typeof LintSourceFn;

let engine: Promise<{ lintSource: LintSource; config: SecretLintCoreConfig }> | undefined;

/**
 * Loaded on first use only, so hook calls that never scan don't pay for it.
 * The config is fixed in memory: the recommended preset and nothing else. No
 * `.secretlintrc` is ever read, so a repository can't weaken the scan.
 */
function loadEngine() {
  engine ??= (async () => {
    const [{ lintSource }, { creator }] = await Promise.all([
      import("@secretlint/core"),
      import("@secretlint/secretlint-rule-preset-recommend"),
    ]);
    const config: SecretLintCoreConfig = {
      rules: [{ id: "@secretlint/secretlint-rule-preset-recommend", rule: creator }],
    };
    return { lintSource, config };
  })();
  return engine;
}

/** Scans in-memory content. Throws when the engine fails, so callers can fail closed. */
export async function scanContent(filePath: string, content: string): Promise<SecretFinding[]> {
  const { lintSource, config } = await loadEngine();
  const result = await lintSource({
    source: { content, filePath, contentType: "text" },
    options: { config, maskSecrets: true, noPhysicFilePath: true },
  });
  return result.messages.map((message) => ({
    path: filePath,
    line: message.loc.start.line,
    ruleId: message.ruleId,
  }));
}

/** Every file under a path, in name order; a path that doesn't exist yields none. */
export async function listFiles(target: string): Promise<string[]> {
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    return [];
  }
  if (stat.isFile()) return [target];
  if (!stat.isDirectory()) return [];
  const entries = await fs.readdir(target, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((entry) => listFiles(path.join(target, entry.name))),
  );
  return nested.flat();
}

/** Scans files and directories on disk; paths that don't exist are skipped. */
export async function scanFiles(targets: readonly string[]): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = [];
  for (const target of targets) {
    // oxlint-disable-next-line no-await-in-loop -- findings keep the caller's order
    for (const file of await listFiles(target)) {
      // oxlint-disable-next-line no-await-in-loop -- one file at a time bounds memory
      const content = await fs.readFile(file, "utf8");
      // oxlint-disable-next-line no-await-in-loop -- see above
      findings.push(...(await scanContent(file, content)));
    }
  }
  return findings;
}

/** One line per finding, for refusal messages: never the value. Line 0 means the whole file. */
export function describeSecretFindings(findings: readonly SecretFinding[]): string[] {
  return findings.map(
    (finding) => `${finding.path}${finding.line > 0 ? `:${finding.line}` : ""} (${finding.ruleId})`,
  );
}
