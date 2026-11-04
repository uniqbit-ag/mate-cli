import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { gitEnvironment } from "../../../runtime/companion-git";
import { CLAUDE_SETTINGS_DOCUMENT } from "../../../runtime/runtime-document-manifest";
import type { WrappedClaudePlugin } from "../../../runtime/wrap-state";

const execFileAsync = promisify(execFile);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Git lists the original Checkout first when it can identify it. */
async function originalCheckout(repoPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain", "-z"], {
      cwd: repoPath,
      env: gitEnvironment(),
      timeout: 3000,
      maxBuffer: 1024 * 1024,
    });
    const first = stdout.split("\0\0", 1)[0]?.split("\0") ?? [];
    if (!first[0]?.startsWith("worktree ") || first.includes("bare")) return undefined;
    const original = first[0].slice("worktree ".length);
    const dotGit = await fs.stat(path.join(original, ".git")).catch(() => undefined);
    if (!dotGit || (!dotGit.isFile() && !dotGit.isDirectory())) return undefined;
    return (await sameDirectory(original, repoPath)) ? undefined : original;
  } catch {
    return undefined;
  }
}

async function readSettings(repoPath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(
      await fs.readFile(path.join(repoPath, CLAUDE_SETTINGS_DOCUMENT), "utf8"),
    ) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function sameDirectory(first: string, second: string): Promise<boolean> {
  if (path.resolve(first) === path.resolve(second)) return true;
  try {
    const [firstReal, secondReal] = await Promise.all([fs.realpath(first), fs.realpath(second)]);
    return firstReal === secondReal;
  } catch {
    return false;
  }
}

function marketplaceSource(settings: Record<string, unknown>, name: string): unknown {
  const marketplaces = settings.extraKnownMarketplaces;
  const entry = isRecord(marketplaces) ? marketplaces[name] : undefined;
  return isRecord(entry) ? entry.source : undefined;
}

/** The absolute folder of a `directory` marketplace source; any other source has none. */
function directoryPath(source: unknown): string | undefined {
  return isRecord(source) &&
    source.source === "directory" &&
    typeof source.path === "string" &&
    path.isAbsolute(source.path)
    ? source.path
    : undefined;
}

/**
 * Only a recorded plugin enabled in both Checkouts can be redirected. A missing,
 * unreadable or ambiguous setting keeps the Wrap's existing delivery decision.
 */
export async function worktreePluginSourceConflicts(
  repoPath: string,
  carried: readonly WrappedClaudePlugin[],
): Promise<string[]> {
  if (carried.length === 0) return [];
  const original = await originalCheckout(repoPath);
  if (!original) return [];
  const [mainSettings, worktreeSettings] = await Promise.all([
    readSettings(original),
    readSettings(repoPath),
  ]);
  if (!mainSettings || !worktreeSettings) return [];
  const mainEnabled = mainSettings.enabledPlugins;
  const worktreeEnabled = worktreeSettings.enabledPlugins;
  if (!isRecord(mainEnabled) || !isRecord(worktreeEnabled)) return [];

  const disabled = new Set(
    carried
      .filter(({ id }) => mainEnabled[id] === false || worktreeEnabled[id] === false)
      .map(({ directory }) => path.resolve(directory)),
  );
  const conflicts = await Promise.all(
    carried.map(async (plugin) => {
      const enabledInBoth = mainEnabled[plugin.id] === true && worktreeEnabled[plugin.id] === true;
      if (!enabledInBoth || disabled.has(path.resolve(plugin.directory))) return undefined;

      const worktreeDirectory = directoryPath(
        marketplaceSource(worktreeSettings, plugin.marketplace),
      );
      if (!worktreeDirectory || !(await sameDirectory(worktreeDirectory, plugin.directory))) {
        return undefined;
      }

      const mainSource = marketplaceSource(mainSettings, plugin.marketplace);
      if (!isRecord(mainSource) || typeof mainSource.source !== "string") return undefined;
      if (mainSource.source !== "directory") return plugin.directory;
      const mainDirectory = directoryPath(mainSource);
      return mainDirectory && !(await sameDirectory(mainDirectory, worktreeDirectory))
        ? plugin.directory
        : undefined;
    }),
  );
  return [
    ...new Set(conflicts.filter((directory): directory is string => directory !== undefined)),
  ];
}
