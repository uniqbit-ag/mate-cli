import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

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

async function capSync(context: FinishContext): Promise<boolean> {
  const previous = process.exitCode;
  process.exitCode = 0;
  const previousEnv = new Map(
    ["MATE_ARTIFACT_PATH", "MATE_REPO_PATH", "MATE_REPO_ID", "MATE_REPO_PROFILE"].map((key) => [
      key,
      process.env[key],
    ]),
  );

  // Pass both sides of the companion/working-repo boundary explicitly. Capability
  // commands resolve their own target paths and do not need a cwd switch.
  process.env.MATE_ARTIFACT_PATH = context.companionPath;
  if (context.repository) {
    process.env.MATE_REPO_PATH = context.repository.path;
    process.env.MATE_REPO_ID = context.repository.id;
    process.env.MATE_REPO_PROFILE = context.repository.profile;
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
export function openspecFinisher(contextOrPath: FinishContext | string): ArtifactFinisher {
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
      const res = run(companionPath, ["openspec", "validate", name, "--json"]);
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
      const res = run(companionPath, ["openspec", "list", "--json"]);
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
      return {
        anchorName,
        commitPaths: await commitPathsForArchive(companionPath, name, anchorName),
      };
    },
    async produce(name) {
      const res = run(companionPath, ["openspec", "archive", name, "--yes"]);
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
      return {
        ok: true,
        produced: {
          anchorName: match[1],
          commitPaths: await commitPathsForArchive(companionPath, name, match[1]),
        },
        message: res.stdout.trim(),
      };
    },
    capSync() {
      return capSync(context);
    },
  };
}
