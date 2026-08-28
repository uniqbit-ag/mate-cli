import fs from "node:fs/promises";
import path from "node:path";

import { version } from "../../../package.json";
import {
  PROJECTION_YAML_FILE,
  computeProjectionStamp,
  readProjectionFile,
  writeProjectionPair,
} from "../../runtime/projection";
import {
  repoLocalDirName,
  repoLocalDirPath,
  repoLocalRegistryPath,
} from "../../runtime/repo-local";
import { TOKENSAVE_WORKING_REPO_EXCLUDE_ENTRIES } from "../../tools/setup/capabilities/tokensave-shared";
import {
  ensureWorkingRepoLocalExcludes,
  managedWorkingRepoExcludesPresent,
  reconcileWorkingRepoCapabilityExcludes,
  removeWorkingRepoLocalExcludes,
  workingRepoCapabilityExcludesPresent,
} from "../../tools/setup/working-repo-local-state";
import { getMateInstallPath } from "../package-paths";
import { companionLinkPresent, linkCompanion, unlinkCompanion } from "./projection-companion-link";
import { buildProjection } from "./projection-record";
import {
  CLAUDE_WORKING_SETTINGS_PATH,
  LEGACY_TOKENSAVE_CLAUDE_MD_PATH,
  legacyTokensaveClaudeMdPresent,
  removeWorkingRepoClaudeSettings,
  stripTokensaveClaudeMdAppend,
  syncWorkingRepoClaudeAdditionalDirectories,
  workingRepoClaudeSettingsPresent,
} from "./projection-claude-entry";
import {
  CLAUDE_LOCAL_CONFIG_DOCUMENT,
  CLAUDE_MCP_DOCUMENT,
  CLAUDE_SETTINGS_DOCUMENT,
  OPENCODE_CONFIG_DOCUMENT,
  placeRuntimeDocument,
  removeRuntimeDocument,
  runtimeDocumentPresent,
} from "./projection-runtime-documents";
import {
  upsertRepoLocalCompanionPointer,
  upsertRepoLocalLinkedRepository,
  writeRepoLocalFrameworkConfig,
} from "./repo-local-store";
import type { ProjectionEntry, ProjectionInput } from "./projection-types";

export const WORKSPACE_DOCUMENT_FILE = "workspace.code-workspace";

/** The shared editor workspace document, inside the Projection Root. */
export function workspaceDocumentPath(repoPath: string): string {
  return path.join(repoLocalDirPath(repoPath), WORKSPACE_DOCUMENT_FILE);
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function writeProjectionPairEntry(input: ProjectionInput): Promise<"written" | "current"> {
  const { companionPath, repository } = input;
  const resolvedCompanionPath = path.resolve(companionPath!);
  const registryContent = await fs
    .readFile(repoLocalRegistryPath(input.repoPath), "utf8")
    .catch(() => "");
  const stamp = computeProjectionStamp({
    version,
    installPath: getMateInstallPath(),
    registryContent,
  });

  /**
   * The stamp cannot see a re-pin: none of its inputs — mate version, install
   * path, repo-local registry — change when a differently-linked companion is
   * resolved, so the projected companion is compared alongside it.
   */
  const existing = readProjectionFile(input.repoPath);
  if (
    existing?.stamp === stamp &&
    path.resolve(existing.projection.companionPath) === resolvedCompanionPath
  ) {
    return "current";
  }

  writeProjectionPair(input.repoPath, {
    stamp,
    projection: buildProjection(resolvedCompanionPath, repository!),
  });
  return "written";
}

function tokensaveEnabled(input: ProjectionInput): boolean {
  return (input.config?.capabilities ?? []).some((capability) => capability.name === "tokensave");
}

/**
 * Built on first use rather than at module evaluation: the catalogue reaches
 * modules that reach back for `project`, so nothing here may be needed before
 * its own module finishes loading.
 */
function buildEntries(): readonly ProjectionEntry[] {
  const localDir = repoLocalDirName();

  return [
    /**
     * First, always. Every scope below writes a path this block covers, so a
     * reader that races a write sees an excluded file rather than a tracked one.
     */
    {
      id: "git-excludes",
      kind: "merged",
      path: path.join(".git", "info", "exclude"),
      scopes: ["link", "session", "launch", "wrap"],
      write: async (input) =>
        (await ensureWorkingRepoLocalExcludes(input.repoPath)) ? "written" : "current",
      removal: {
        by: "self",
        remove: async (input) =>
          (await removeWorkingRepoLocalExcludes(input.repoPath)) ? "removed" : "absent",
      },
      present: managedWorkingRepoExcludesPresent,
    },
    {
      id: "projection-root",
      kind: "owned",
      path: localDir,
      scopes: ["link", "session", "workspace", "wrap"],
      write: async (input) => {
        const root = repoLocalDirPath(input.repoPath);
        if (await pathExists(root)) return "current";
        await fs.mkdir(root, { recursive: true });
        return "written";
      },
      removal: {
        by: "self",
        remove: async (input) => {
          const root = repoLocalDirPath(input.repoPath);
          if (!(await pathExists(root))) return "absent";
          await fs.rm(root, { recursive: true, force: true });
          return "removed";
        },
      },
    },
    /**
     * Directly after the root that holds it, so every scope that writes the
     * root also exposes the companion through it.
     */
    {
      id: "companion-link",
      kind: "owned",
      path: path.join(localDir, "companion"),
      scopes: ["link", "session", "wrap"],
      write: async (input) =>
        input.companionPath ? linkCompanion(input.repoPath, input.companionPath) : "skipped",
      degradable: true,
      removal: {
        by: "self",
        remove: (input) => unlinkCompanion(input.repoPath),
      },
      present: companionLinkPresent,
    },
    {
      id: "repo-local-framework",
      kind: "owned",
      path: path.join(localDir, "config", "framework.yaml"),
      scopes: ["link"],
      write: async (input) =>
        (await writeRepoLocalFrameworkConfig(input.repoPath)) ? "written" : "current",
      removal: { by: "entry", entry: "projection-root" },
    },
    {
      id: "repo-local-registry",
      kind: "owned",
      path: path.join(localDir, "config", "registry.yaml"),
      scopes: ["link"],
      write: async (input) => {
        if (!input.companionPath || !input.repository || !input.source) return "skipped";
        await upsertRepoLocalLinkedRepository(input.repoPath, input.repository);
        await upsertRepoLocalCompanionPointer(
          input.repoPath,
          input.companionPath,
          input.repository.id,
          input.source,
        );
        return "written";
      },
      removal: { by: "entry", entry: "projection-root" },
    },
    /** One entry, two files: the pair is written as a unit or not at all. */
    {
      id: "projection-pair",
      kind: "owned",
      path: path.join(localDir, PROJECTION_YAML_FILE),
      scopes: ["session"],
      write: async (input) =>
        input.companionPath && input.repository ? writeProjectionPairEntry(input) : "skipped",
      removal: { by: "entry", entry: "projection-root" },
    },
    /**
     * Deliberately outside the managed block, so a Capability's exclusion
     * survives a core-block rewrite — and therefore survives `unproject` too,
     * because the Capability's local data does.
     */
    {
      id: "capability-excludes",
      kind: "merged",
      path: path.join(".git", "info", "exclude"),
      scopes: ["launch"],
      write: async (input) => {
        if (!input.config) return "skipped";
        return (await reconcileWorkingRepoCapabilityExcludes(
          input.repoPath,
          tokensaveEnabled(input) ? TOKENSAVE_WORKING_REPO_EXCLUDE_ENTRIES : [],
          TOKENSAVE_WORKING_REPO_EXCLUDE_ENTRIES,
        ))
          ? "written"
          : "current";
      },
      removal: {
        by: "retained",
        because: "the Capability's local data is still in the Working Repository",
      },
      present: (repoPath) =>
        workingRepoCapabilityExcludesPresent(repoPath, TOKENSAVE_WORKING_REPO_EXCLUDE_ENTRIES),
    },
    {
      id: "claude-working-settings",
      kind: "merged",
      path: CLAUDE_WORKING_SETTINGS_PATH,
      scopes: ["launch", "wrap"],
      write: async (input) =>
        input.companionPath
          ? syncWorkingRepoClaudeAdditionalDirectories(
              input.repoPath,
              input.companionPath,
              input.globalConfigStore,
            )
          : "skipped",
      removal: {
        by: "self",
        remove: (input) =>
          removeWorkingRepoClaudeSettings(input.repoPath, input.registeredCompanionPaths ?? []),
      },
      present: workingRepoClaudeSettingsPresent,
    },
    /**
     * Removal-only: Mate never writes this block, an external installer does.
     * Its `write` is the same strip, so a launch heals a repository the
     * installer touched without waiting for a cleanup.
     */
    {
      id: "legacy-tokensave-claude-md",
      kind: "merged",
      path: LEGACY_TOKENSAVE_CLAUDE_MD_PATH,
      scopes: ["launch"],
      write: async (input) =>
        (await stripTokensaveClaudeMdAppend(input.repoPath)) === "removed" ? "written" : "current",
      removal: { by: "self", remove: (input) => stripTokensaveClaudeMdAppend(input.repoPath) },
      present: legacyTokensaveClaudeMdPresent,
    },
    {
      id: "workspace-document",
      kind: "owned",
      path: path.join(localDir, WORKSPACE_DOCUMENT_FILE),
      scopes: ["workspace"],
      write: async (input) => {
        if (!input.companionPath) return "skipped";
        const target = workspaceDocumentPath(input.repoPath);
        const folders = [path.resolve(input.repoPath), path.resolve(input.companionPath)];
        const next = `${JSON.stringify({ folders: folders.map((candidate) => ({ path: candidate })) }, null, 2)}\n`;
        if ((await fs.readFile(target, "utf8").catch(() => null)) === next) return "current";
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, next, "utf8");
        return "written";
      },
      removal: { by: "entry", entry: "projection-root" },
    },
    /**
     * Last: the documents an Agent Runtime discovers on its own. One declaration
     * per destination, all three placing a value some Runtime Surface rendered —
     * no format knowledge reaches this catalogue.
     *
     * A launch renders them again, because every value here is pinned to the
     * mate that wrote it — the OpenCode plugin package's version, the plugin
     * root the Claude hook commands name — and a repository wrapped once would
     * otherwise keep the pins of whichever release wrapped it. Re-rendering is
     * reconciliation, not an append: `placeRuntimeDocument` withdraws what the
     * previous pass recorded before applying this one's, and a pass that
     * supplied no render at all claims nothing and leaves the record standing.
     *
     * The `launch` scope declares them so `mate working cleanup` reaches them
     * and so a launch answers for a destination it finds recorded, but a launch
     * renders nothing for them: a Managed Session is refused in a wrapped
     * repository, so the only pass that ever places one is `mate wrap`.
     */
    /**
     * Removal-only, like the legacy CLAUDE.md append: releases before local
     * scope projected the companion's MCP servers here, and a server left in
     * `.mcp.json` would sit "pending approval" forever beside the live local
     * one. Its `write` is the same strip, so a re-wrap heals a repository an
     * older mate wrapped without waiting for a cleanup.
     */
    {
      id: "mcp-runtime-document",
      kind: "merged",
      path: CLAUDE_MCP_DOCUMENT,
      scopes: ["launch", "wrap"],
      write: async (input) =>
        (await removeRuntimeDocument(input.repoPath, CLAUDE_MCP_DOCUMENT)) === "removed"
          ? "written"
          : "current",
      removal: {
        by: "self",
        remove: (input) => removeRuntimeDocument(input.repoPath, CLAUDE_MCP_DOCUMENT),
      },
      present: (repoPath) => runtimeDocumentPresent(repoPath, CLAUDE_MCP_DOCUMENT),
    },
    ...(
      [
        ["claude-runtime-document", CLAUDE_SETTINGS_DOCUMENT],
        ["claude-local-mcp-document", CLAUDE_LOCAL_CONFIG_DOCUMENT],
        ["opencode-runtime-document", OPENCODE_CONFIG_DOCUMENT],
      ] as const
    ).map(([id, documentPath]) => ({
      id,
      kind: "merged" as const,
      path: documentPath.split("/").join(path.sep),
      scopes: ["launch", "wrap"] as const,
      write: (input: ProjectionInput) =>
        placeRuntimeDocument(input.repoPath, documentPath, input.runtimeDocuments),
      removal: {
        by: "self" as const,
        remove: (input: { repoPath: string }) =>
          removeRuntimeDocument(input.repoPath, documentPath),
      },
      present: (repoPath: string) => runtimeDocumentPresent(repoPath, documentPath),
    })),
  ];
}

let entries: readonly ProjectionEntry[] | null = null;

export function projectionEntries(): readonly ProjectionEntry[] {
  entries ??= buildEntries();
  return entries;
}
