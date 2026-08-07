import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { hasOpenspecCapability } from "../../../../lib/orchestrator/capabilities";
import { runIndexCapCommand } from "../../cap/index-cmd";
import type { ArtifactFinisher, FinishContext } from "./finisher";

function run(
  companionPath: string,
  args: string[],
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: companionPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function commitPathsForArchive(
  companionPath: string,
  name: string,
  anchorName: string,
): Promise<string[]> {
  const archiveRelative = path.posix.join("openspec", "changes", "archive", anchorName);
  const deltaSpecsDir = path.join(companionPath, archiveRelative, "specs");
  const canonicalSpecs: string[] = [];
  const collectDeltaSpecFiles = async (directory: string, relative = ""): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryRelative = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        await collectDeltaSpecFiles(path.join(directory, entry.name), entryRelative);
      } else if (entry.isFile()) {
        canonicalSpecs.push(path.posix.join("openspec", "specs", entryRelative));
      }
    }
  };
  try {
    await collectDeltaSpecFiles(deltaSpecsDir);
  } catch {
    // Changes without delta specs still commit their active deletion and archive.
  }
  return [
    path.posix.join("openspec", "changes", name),
    archiveRelative,
    ...canonicalSpecs.toSorted(),
  ];
}

const BOM = "﻿";

interface ScopePair {
  repository: string;
  area: string;
}

type ProjectionResult =
  | { ok: true; repository: string; areas: string[] }
  | { ok: false; reason: string };

function parseDeltaScopes(source: string): ScopePair[] {
  const text = source.startsWith(BOM) ? source.slice(BOM.length) : source;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return [];

  try {
    const parsed = parse(match[1]) as unknown;
    if (!parsed || typeof parsed !== "object") return [];
    const scopes = (parsed as Record<string, unknown>).scopes;
    if (!Array.isArray(scopes)) return [];
    return scopes.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const pair = entry as Record<string, unknown>;
      return typeof pair.repository === "string" && typeof pair.area === "string"
        ? [{ repository: pair.repository, area: pair.area }]
        : [];
    });
  } catch {
    return [];
  }
}

function projectDeltaScopes(scopes: ScopePair[]): ProjectionResult {
  if (scopes.length === 0) return { ok: false, reason: "delta declares no scopes entries" };
  const repositories = [...new Set(scopes.map((entry) => entry.repository))];
  if (repositories.length > 1) {
    return {
      ok: false,
      reason: `delta names ${repositories.length} repositories (${repositories.join(", ")}); a spec names exactly one`,
    };
  }
  return {
    ok: true,
    repository: repositories[0],
    areas: [...new Set(scopes.map((entry) => entry.area))],
  };
}

async function archivedChangeUsesMateV1(
  companionPath: string,
  anchorName: string,
): Promise<boolean> {
  try {
    const metadataPath = path.join(
      companionPath,
      "openspec",
      "changes",
      "archive",
      anchorName,
      ".openspec.yaml",
    );
    const parsed = parse(await fs.readFile(metadataPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return false;
    const schema = (parsed as Record<string, unknown>).schema;
    return typeof schema === "string" && schema.trim() === "mate-v1";
  } catch {
    return false;
  }
}

/** Scope keys are omitted when the delta had none — a partial block beats no frontmatter. */
function renderCanonicalFrontmatter(
  capability: string,
  scope: { repository: string; areas: string[] } | null,
): string {
  return [
    "---",
    "type: spec",
    `capability: ${capability}`,
    ...(scope ? [`repository: ${scope.repository}`, `areas: [${scope.areas.join(", ")}]`] : []),
    "tags: [openspec/spec]",
    "---",
    "",
    "",
  ].join("\n");
}

/**
 * Prepends canonical frontmatter to main specs born during this archive.
 *
 * `openspec archive` rebuilds a brand-new main spec from a skeleton with no frontmatter slot,
 * so scope metadata dies exactly once, at spec birth; existing specs keep theirs because only
 * requirement blocks are spliced. Best-effort by design — the archive already succeeded, so a
 * failure here warns rather than stranding the change archived-but-unfinished.
 */
async function reconcileMainSpecFrontmatter(
  companionPath: string,
  anchorName: string,
): Promise<string[]> {
  if (!(await archivedChangeUsesMateV1(companionPath, anchorName))) return [];

  const deltaSpecsDir = path.join(
    companionPath,
    "openspec",
    "changes",
    "archive",
    anchorName,
    "specs",
  );
  const reconciled: string[] = [];

  const walk = async (directory: string, relative = ""): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryRelative = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        await walk(path.join(directory, entry.name), entryRelative);
        continue;
      }
      if (!entry.isFile() || entry.name !== "spec.md") continue;

      const capability = path.posix.dirname(entryRelative);
      if (capability === ".") continue;
      const canonicalRelative = path.posix.join("openspec", "specs", entryRelative);
      const canonicalPath = path.join(companionPath, canonicalRelative);

      try {
        const canonical = await fs.readFile(canonicalPath, "utf8");
        if (canonical.replace(BOM, "").startsWith("---")) continue;

        const deltaSource = await fs.readFile(path.join(directory, entry.name), "utf8");
        const scopes = parseDeltaScopes(deltaSource);
        const projected = projectDeltaScopes(scopes);

        /** Multi-repository is invalid input, so skip; absent scopes still earn a partial block. */
        if (!projected.ok && scopes.length > 0) {
          process.stderr.write(
            `mate: skipped frontmatter for ${canonicalRelative}: ${projected.reason}\n`,
          );
          continue;
        }
        const head = renderCanonicalFrontmatter(
          capability,
          projected.ok ? { repository: projected.repository, areas: projected.areas } : null,
        );
        await fs.writeFile(canonicalPath, head + canonical.replace(BOM, ""), "utf8");
        reconciled.push(canonicalRelative);
      } catch (error) {
        process.stderr.write(
          `mate: could not reconcile frontmatter for ${canonicalRelative}: ${String(error)}\n`,
        );
      }
    }
  };

  await walk(deltaSpecsDir);
  return reconciled;
}

async function capSync(context: FinishContext): Promise<boolean> {
  const previous = process.exitCode;
  process.exitCode = 0;
  const previousEnv = new Map(
    ["MATE_ARTIFACT_PATH", "MATE_REPO_PATH", "MATE_REPO_ID"].map((key) => [key, process.env[key]]),
  );

  // Pass both sides of the companion/working-repo boundary explicitly. Capability
  // commands resolve their own target paths and do not need a cwd switch.
  process.env.MATE_ARTIFACT_PATH = context.companionPath;
  if (context.repository) {
    process.env.MATE_REPO_PATH = context.repository.path;
    process.env.MATE_REPO_ID = context.repository.id;
  }
  try {
    await runIndexCapCommand([]);
    return process.exitCode === 0;
  } catch (error) {
    process.stderr.write(`mate: capability sync failed: ${String(error)}\n`);
    return false;
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.exitCode = previous;
  }
}

/**
 * The openspec artifact finisher: validate/complete guards over the change, `openspec
 * archive` as the terminal transform, an openspec-scoped cap sync, and a commit scoped
 * to `openspec/`. Resumable detection reads the dated `openspec/changes/archive/` folder
 * openspec actually created so the tag is never a computed date.
 */
export function openspecFinisher(
  contextOrPath: FinishContext | string,
  runCommand: typeof run = run,
): ArtifactFinisher {
  const context: FinishContext =
    typeof contextOrPath === "string"
      ? { companionPath: contextOrPath, repositoryId: "" }
      : contextOrPath;
  const companionPath = context.companionPath;

  return {
    type: "openspec",
    disabledReason: "mate: the openspec capability must be enabled to run artifact finish.",
    isEnabled(capabilities) {
      return hasOpenspecCapability(capabilities);
    },
    async validate(name) {
      const res = runCommand(companionPath, ["openspec", "validate", name, "--json"]);
      try {
        const parsed = JSON.parse(res.stdout) as {
          items?: Array<{ id: string; valid: boolean; issues?: Array<{ message: string }> }>;
        };
        const item = parsed.items?.find((entry) => entry.id === name) ?? parsed.items?.[0];
        if (!item) {
          return { valid: false, errors: [res.stderr.trim() || "no validation result"] };
        }
        return { valid: item.valid, errors: (item.issues ?? []).map((issue) => issue.message) };
      } catch {
        return {
          valid: res.status === 0,
          errors: res.status === 0 ? [] : [res.stderr.trim() || "validation failed"],
        };
      }
    },
    async isComplete(name) {
      const res = runCommand(companionPath, ["openspec", "list", "--json"]);
      try {
        const parsed = JSON.parse(res.stdout) as {
          changes?: Array<{ name: string; completedTasks: number; totalTasks: number }>;
        };
        const change = parsed.changes?.find((entry) => entry.name === name);
        if (!change) {
          return { complete: false, total: 0, remaining: 0 };
        }
        const remaining = change.totalTasks - change.completedTasks;
        return { complete: remaining <= 0, total: change.totalTasks, remaining };
      } catch {
        return { complete: false, total: 0, remaining: 0 };
      }
    },
    async detectProduced(name) {
      const archiveDir = path.join(companionPath, "openspec", "changes", "archive");
      let entries;
      try {
        entries = await fs.readdir(archiveDir, { withFileTypes: true });
      } catch {
        return null;
      }
      const pattern = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${escapeRegExp(name)}$`);
      const matches = entries
        .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
        .map((entry) => entry.name)
        .toSorted();
      if (matches.length === 0) {
        return null;
      }
      // Latest dated folder wins if the same change name was ever archived twice.
      const anchorName = matches[matches.length - 1];
      const commitPaths = await commitPathsForArchive(companionPath, name, anchorName);
      await reconcileMainSpecFrontmatter(companionPath, anchorName);
      return { anchorName, commitPaths };
    },
    async produce(name) {
      const res = runCommand(companionPath, ["openspec", "archive", name, "--yes"]);
      if (res.status !== 0) {
        return {
          ok: false,
          produced: null,
          message: res.stderr.trim() || res.stdout.trim() || "archive failed",
        };
      }
      // openspec prints: Change '<name>' archived as '<date>-<name>'.
      const match = res.stdout.match(/archived as '([^']+)'/);
      if (!match) {
        return { ok: false, produced: null, message: "could not detect archived folder name" };
      }
      const commitPaths = await commitPathsForArchive(companionPath, name, match[1]);
      await reconcileMainSpecFrontmatter(companionPath, match[1]);
      return {
        ok: true,
        produced: { anchorName: match[1], commitPaths },
        message: res.stdout.trim(),
      };
    },
    capSync() {
      return capSync(context);
    },
  };
}
