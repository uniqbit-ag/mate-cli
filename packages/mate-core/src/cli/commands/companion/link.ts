import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { FRAMEWORK_NAME } from "../../../framework";
import {
  selectCompanionLinkInputs,
  type CompanionLinkInputs,
  type CompanionLinkWizardOptions,
  type ExistingCompanion,
} from "../../companion-link-wizard";
import { extractRepoName } from "../artifact/extract-repo-name";
import { GlobalConfigStore } from "../../../lib/orchestrator/global-config-store";
import { linkIdFor } from "../../../lib/orchestrator/registry-checkouts";
import {
  RepoLocalRegistryStore,
  removeRepoLocalCompanionPointer,
} from "../../../lib/orchestrator/repo-local-store";
import {
  CompanionResolver,
  companionRootedStore,
  findDescendantRepoLocalRegistries,
} from "../../../lib/orchestrator/repository-link";
import { errorMessage } from "../../../runtime/error-message";
import { remoteIdentity } from "../../../runtime/forge-remote";
import { namesOtherCheckout, originUrlOf, readGitLayout } from "../../../runtime/git-layout";
import { repoLocalRegistryPath } from "../../../runtime/repo-local";
import { localRootKind } from "../../../lib/orchestrator/root-context";
import { inspectSetupPreflight } from "../../../lib/orchestrator/setup-preflight";
import { runSetupFlowAtPath } from "../setup";
import { runInstallCommand } from "../install";
import type { CompanionSource, LinkedRepository } from "../../../lib/orchestrator/types";
import { invalidateInstallState } from "../../../lib/install";
import { createStartupProgress } from "../../../lib/components/startup-progress";
import { companionGit, describeGitFailure, type GitResult } from "../../../runtime/companion-git";

interface CompanionLinkCommandDeps {
  selectCompanionLinkInputs?: (
    options: CompanionLinkWizardOptions,
  ) => Promise<CompanionLinkInputs | null>;
  extractRepoName?: (url: string) => string | null;
  cloneCompanion?: (url: string, destination: string) => Promise<GitResult>;
  mkdir?: typeof fs.mkdir;
  stat?: typeof fs.stat;
  listCompanions?: () => Promise<string[]>;
  registerCompanion?: (companionPath: string) => Promise<void>;
  /** The companions `cwd` resolves to now, read without writing. */
  currentCompanions?: (cwd: string) => Promise<string[]>;
  detectCompanionFolders?: (cwd: string) => Promise<string[]>;
  readOrigin?: (folder: string) => string | null;
  removeRepoLocalPointer?: (repoPath: string, companionPath: string) => Promise<void>;
  removeCompanionRepository?: (companionPath: string, repositoryPath: string) => Promise<void>;
  registerRepository?: (
    repository: LinkedRepository,
    options: { companionPath: string; companionSource: CompanionSource },
  ) => Promise<LinkedRepository>;
  inspectSetupPreflight?: typeof inspectSetupPreflight;
  runSetupFlowAtPath?: typeof runSetupFlowAtPath;
  installCompanion?: (companionPath: string) => Promise<boolean | void>;
  isDirectory?: (candidatePath: string) => Promise<boolean>;
  findDescendantRepoLocalRegistries?: typeof findDescendantRepoLocalRegistries;
  createProgress?: typeof createStartupProgress;
}

/**
 * A registry in another Checkout of this clone that names a companion just
 * linked is that Checkout's Adoption, not a shadow: resolution from inside a
 * linked worktree never reaches this folder's link (design Decisions 3 and 14).
 */
async function adoptedCheckout(
  cwd: string,
  shadowedPath: string,
  companionPaths: readonly string[],
): Promise<boolean> {
  if (!namesOtherCheckout(cwd, shadowedPath)) return false;
  const linked = new Set(companionPaths.map((companionPath) => path.resolve(companionPath)));
  const local = await new RepoLocalRegistryStore(repoLocalRegistryPath(shadowedPath))
    .load()
    .catch(() => null);
  return (local?.companions ?? []).some((pointer) => linked.has(path.resolve(pointer.path)));
}

/** Where the git source clones companions. */
function companionsHomeDir(): string {
  return path.join(os.homedir(), `.${FRAMEWORK_NAME}`, "companions");
}

function isInsideDir(parentDir: string, candidatePath: string): boolean {
  const relative = path.relative(parentDir, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Only `cwd`'s own links: Replace cannot remove one inherited from an ancestor folder or another Checkout.
async function currentCompanionsOf(cwd: string): Promise<string[]> {
  const { match, ambiguousMatches } = await new CompanionResolver(
    new GlobalConfigStore(),
  ).resolveWithDiagnostics(cwd, { write: false, own: true });
  const matches = ambiguousMatches.length > 0 ? ambiguousMatches : match ? [match] : [];
  return matches.map((current) => path.resolve(current.companionPath));
}

async function isCompanionFolder(folder: string): Promise<boolean> {
  return (await localRootKind(folder)) === "companion";
}

/** Companion folders among the direct children of `folder` and of its parent; no deeper scan. */
async function detectCompanionFoldersNear(folder: string): Promise<string[]> {
  const found = await Promise.all(
    [folder, path.dirname(folder)].map(async (parent) => {
      const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
      return Promise.all(
        entries
          .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
          .map(async (entry) => {
            const child = path.join(parent, entry.name);
            return (await isCompanionFolder(child)) ? child : null;
          }),
      );
    }),
  );
  return found.flat().filter((child): child is string => child !== null);
}

/** Raw config, so an `insteadOf` rewrite does not change the identity. */
function readOriginUrl(folder: string): string | null {
  const layout = readGitLayout(folder);
  return layout ? originUrlOf(layout) : null;
}

/** Identities when both URLs parse; a URL `parseRemote` cannot read, such as a local path, compares as written. */
function sameRemote(origin: string | null, url: string): boolean {
  if (!origin) return false;
  const originIdentity = remoteIdentity(origin);
  const urlIdentity = remoteIdentity(url);
  // Forges match owner and repository case-insensitively.
  return originIdentity !== null && urlIdentity !== null
    ? originIdentity.toLowerCase() === urlIdentity.toLowerCase()
    : origin.trim() === url.trim();
}

function chosenCompanionPaths(
  inputs: CompanionLinkInputs,
  companionsDir: string,
  extractName: (url: string) => string | null,
): string[] {
  if (inputs.source === "git") {
    if (inputs.clonePath) return [path.resolve(inputs.clonePath)];
    const repoName = extractName(inputs.gitUrl ?? "");
    return repoName ? [path.join(companionsDir, repoName)] : [];
  }
  if (inputs.source === "existing") {
    return (inputs.companionPaths ?? []).map((companionPath) => path.resolve(companionPath));
  }
  const localPath = inputs.localPath?.trim();
  return localPath ? [path.resolve(localPath)] : [];
}

export const companionLinkCommandDeps = {
  runCompanionLinkCommandWithDeps: (argv: string[]) => runCompanionLinkCommandWithDeps(argv),
};

export async function runCompanionLinkCommand(argv: string[]): Promise<void> {
  return companionLinkCommandDeps.runCompanionLinkCommandWithDeps(argv);
}

function warnOnFailure(removal: Promise<void>, failure: string): Promise<void> {
  return removal.catch((error: unknown) => {
    console.error(`mate: warning: could not remove ${failure}: ${errorMessage(error)}`);
  });
}

function exitWithError(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

export async function runCompanionLinkCommandWithDeps(
  argv: string[],
  deps: CompanionLinkCommandDeps = {},
): Promise<void> {
  if (argv.length > 0) {
    exitWithError("mate: `companion link` is TUI-only in this change and does not accept flags.");
  }
  if (!process.stdin.isTTY) {
    exitWithError("mate: `companion link` requires a TTY.");
  }

  const selectInputs = deps.selectCompanionLinkInputs ?? selectCompanionLinkInputs;
  const extractName = deps.extractRepoName ?? extractRepoName;
  const cloneCompanion =
    deps.cloneCompanion ??
    ((url: string, destination: string) =>
      companionGit(path.dirname(destination), { prompt: "if-terminal" }).clone(url, destination));
  const mkdir = deps.mkdir ?? fs.mkdir;
  const stat = deps.stat ?? fs.stat;
  const createProgress = deps.createProgress ?? createStartupProgress;
  const listCompanions =
    deps.listCompanions ??
    (() => {
      const globalConfigStore = new GlobalConfigStore();
      return globalConfigStore.list.bind(globalConfigStore);
    })();
  const currentCompanions = deps.currentCompanions ?? currentCompanionsOf;
  const detectCompanionFolders = deps.detectCompanionFolders ?? detectCompanionFoldersNear;
  const readOrigin = deps.readOrigin ?? readOriginUrl;
  const removeRepoLocalPointer = deps.removeRepoLocalPointer ?? removeRepoLocalCompanionPointer;
  const removeCompanionRepository =
    deps.removeCompanionRepository ??
    ((companionPath, repositoryPath) =>
      companionRootedStore(companionPath).removeRepository(repositoryPath));
  const registerCompanion =
    deps.registerCompanion ??
    (() => {
      const globalConfigStore = new GlobalConfigStore();
      return globalConfigStore.register.bind(globalConfigStore);
    })();
  const inspectPreflight = deps.inspectSetupPreflight ?? inspectSetupPreflight;
  const runSetup = deps.runSetupFlowAtPath ?? runSetupFlowAtPath;
  const installCompanion =
    deps.installCompanion ?? ((companionPath) => runInstallCommand([], companionPath));
  const findShadowedRegistries =
    deps.findDescendantRepoLocalRegistries ?? findDescendantRepoLocalRegistries;

  const cwd = path.resolve(process.cwd());
  const companionsDir = companionsHomeDir();
  const [current, registeredPaths, detected] = await Promise.all([
    currentCompanions(cwd),
    listCompanions(),
    detectCompanionFolders(cwd),
  ]);
  const registered = new Set(registeredPaths.map((candidate) => path.resolve(candidate)));
  const candidatePaths = [
    ...new Set(
      [...registered, ...current, ...detected].map((candidate) => path.resolve(candidate)),
    ),
  ].filter((candidate) => candidate !== cwd);
  const existingCompanions = (
    await Promise.all(
      candidatePaths.map(async (companionPath): Promise<ExistingCompanion | null> => {
        const target = await stat(companionPath).catch(() => null);
        if (!target?.isDirectory()) return null;
        // A stale registration of a working repository or hub is no companion.
        const kind = await localRootKind(companionPath);
        if (kind === "working" || kind === "hub") return null;
        return { path: companionPath, registered: registered.has(companionPath) };
      }),
    )
  ).filter((candidate): candidate is ExistingCompanion => candidate !== null);
  // Read on first use: most links never take the Git URL step.
  const origins = new Map<string, string | null>();
  const originOf = (companionPath: string) => {
    if (!origins.has(companionPath)) origins.set(companionPath, readOrigin(companionPath));
    return origins.get(companionPath) ?? null;
  };

  const replacedBy = (chosenInputs: CompanionLinkInputs): string[] => {
    const chosen = new Set(chosenCompanionPaths(chosenInputs, companionsDir, extractName));
    return chosen.size > 0 ? current.filter((companionPath) => !chosen.has(companionPath)) : [];
  };

  const inputs = await selectInputs({
    existingCompanions,
    clonesOf: (gitUrl) =>
      existingCompanions
        .filter((companion) => sameRemote(originOf(companion.path), gitUrl))
        .map((companion) => companion.path),
    replacedBy,
  });
  if (!inputs) {
    exitWithError("Aborted.");
  }

  const companionSource = inputs.source;
  const companionPaths = chosenCompanionPaths(inputs, companionsDir, extractName);

  if (companionSource === "git" && !inputs.clonePath) {
    const gitUrl = inputs.gitUrl ?? "";
    const [companionPath] = companionPaths;
    if (!companionPath) {
      exitWithError(`mate: could not extract repository name from URL: ${gitUrl}`);
    }

    const existingTarget = await stat(companionPath).catch(() => null);
    if (existingTarget?.isDirectory()) {
      const origin = readOrigin(companionPath);
      if (!sameRemote(origin, gitUrl)) {
        exitWithError(
          `mate: ${companionPath} already exists with origin ${origin ?? "(none)"}, not ${gitUrl}. Move that folder away, or link it with "Enter the path of another folder".`,
        );
      }
    } else {
      await mkdir(companionsDir, { recursive: true });
      // Git may ask for credentials: a labelled hand-over, never a spinner.
      const progress = createProgress("Linking companion");
      let clone: GitResult;
      try {
        progress.handOver("clone", "Cloning companion");
        clone = await cloneCompanion(gitUrl, companionPath);
        if (clone.status === 0) progress.succeed("clone");
        else progress.fail("clone");
      } finally {
        progress.stop();
      }
      if (clone.status !== 0) {
        const detail = describeGitFailure(clone);
        exitWithError(
          `mate: failed to clone companion repository:\n${
            detail === "unknown Git error" ? "review the Git or SSH diagnostics above" : detail
          }`,
        );
      }
    }
  } else if (companionSource === "existing") {
    if (companionPaths.length === 0) {
      exitWithError("mate: no existing companion was selected.");
    }
    const targets = await Promise.all(
      companionPaths.map((companionPath) => stat(companionPath).catch(() => null)),
    );
    const notADirectory = companionPaths.find((_, index) => !targets[index]?.isDirectory());
    if (notADirectory) {
      exitWithError(`mate: existing companion must be a directory: ${notADirectory}`);
    }
  } else if (companionSource === "local") {
    const [companionPath] = companionPaths;
    if (!companionPath) {
      exitWithError("mate: no local companion path was provided.");
    }
    const existingTarget = await stat(companionPath).catch(() => null);
    if (!existingTarget?.isDirectory()) {
      exitWithError(`mate: local companion must be a directory: ${companionPath}`);
    }
  }

  /** The registry keeps the ID of an entry the clone already has, and the link names the kept one. */
  const repository: LinkedRepository = {
    id: linkIdFor(cwd),
    path: cwd,
  };

  // Writes both the companion-side registry entry (companionRootedStore, the
  // source of truth for the aggregate pairing inventory) and the repo-local
  // pointer (CompanionStore's internal dual write) in one call.
  const registerRepository =
    deps.registerRepository ??
    ((nextRepository, options) =>
      companionRootedStore(options.companionPath).registerRepository(nextRepository, {
        companionSource: options.companionSource,
      }));

  const sourceOf = (companionPath: string): CompanionSource =>
    isInsideDir(companionsDir, companionPath) ? "git" : "local";

  // After the first new link is written, so a failed setup or link leaves the old one in place.
  const removeReplaced = async () => {
    /* oxlint-disable no-await-in-loop -- one replaced companion after another */
    for (const replacedPath of inputs.replace ? replacedBy(inputs) : []) {
      await warnOnFailure(
        removeRepoLocalPointer(cwd, replacedPath),
        `the link to ${replacedPath} from ${cwd}`,
      );
      await warnOnFailure(
        removeCompanionRepository(replacedPath, cwd),
        `${cwd} from the registry of ${replacedPath}`,
      );
    }
    /* oxlint-enable no-await-in-loop */
  };

  let keptId: string | undefined;
  /* oxlint-disable no-await-in-loop -- each companion is set up, linked and installed in turn; a declined install stops the rest */
  for (const companionPath of companionPaths) {
    const preflight = await inspectPreflight(companionPath);
    // A clone found on this machine already holds its framework.yaml.
    if (companionSource === "git" && !inputs.clonePath && preflight.kind !== "existing-companion") {
      await runSetup(companionPath);
    }

    const kept = await registerRepository(repository, {
      companionPath,
      companionSource: sourceOf(companionPath),
    });
    if (keptId === undefined) {
      keptId = kept.id;
      await removeReplaced();
    }
    await registerCompanion(companionPath);
    await invalidateInstallState({ kind: "companion", companionPath });
    if ((await installCompanion(companionPath)) === false) return;
  }
  /* oxlint-enable no-await-in-loop */

  let shadowedPaths: string[] = [];
  try {
    const found = await findShadowedRegistries(cwd);
    const adopted = await Promise.all(
      found.map((shadowedPath) => adoptedCheckout(cwd, shadowedPath, companionPaths)),
    );
    shadowedPaths = found.filter((_shadowedPath, index) => !adopted[index]);
  } catch {
    // A diagnostic scan must never fail an otherwise successful link.
  }
  if (shadowedPaths.length > 0) {
    console.error("Warning: existing companion links will shadow this new link:");
    for (const shadowedPath of shadowedPaths) {
      console.error(`  ${shadowedPath}`);
    }
    console.error(
      "Mate commands run from inside these directories will keep resolving to their existing link instead of the one just created.",
    );
  }

  console.log(`Successfully linked companion for ${keptId ?? repository.id}`);
  for (const companionPath of companionPaths) {
    console.log(`  Companion: ${companionPath}`);
    console.log(`  Source: ${sourceOf(companionPath)}`);
  }
  console.log("  Workspace: run `mate companion open` to open the workspace in your editor");
}
