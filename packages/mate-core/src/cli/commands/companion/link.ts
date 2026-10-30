import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { FRAMEWORK_NAME } from "../../../framework";
import {
  selectCompanionLinkInputs,
  type CompanionLinkInputs,
  type CompanionLinkWizardOptions,
} from "../../companion-link-wizard";
import { extractRepoName } from "../artifact/extract-repo-name";
import { GlobalConfigStore } from "../../../lib/orchestrator/global-config-store";
import { linkIdFor } from "../../../lib/orchestrator/registry-checkouts";
import { RepoLocalRegistryStore } from "../../../lib/orchestrator/repo-local-store";
import {
  CompanionResolver,
  companionRootedStore,
  findDescendantRepoLocalRegistries,
} from "../../../lib/orchestrator/repository-link";
import { namesOtherCheckout } from "../../../runtime/git-layout";
import { repoLocalRegistryPath } from "../../../runtime/repo-local";
import { inspectSetupPreflight } from "../../../lib/orchestrator/setup-preflight";
import { runSetupFlowAtPath } from "../setup";
import { runInstallCommand } from "../install";
import type { CompanionSource, LinkedRepository } from "../../../lib/orchestrator/types";
import { invalidateInstallState } from "../../../lib/install";
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
  resolveCompanion?: (cwd: string) => ReturnType<CompanionResolver["resolve"]>;
  registerRepository?: (
    repository: LinkedRepository,
    options: { companionPath: string; companionSource: CompanionSource },
  ) => Promise<LinkedRepository>;
  inspectSetupPreflight?: typeof inspectSetupPreflight;
  runSetupFlowAtPath?: typeof runSetupFlowAtPath;
  installCompanion?: (companionPath: string) => Promise<boolean | void>;
  isDirectory?: (candidatePath: string) => Promise<boolean>;
  findDescendantRepoLocalRegistries?: typeof findDescendantRepoLocalRegistries;
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

/** All companions surfaced by the "existing companion" picker live under this directory. */
function companionsHomeDir(): string {
  return path.join(os.homedir(), `.${FRAMEWORK_NAME}`, "companions");
}

function isInsideDir(parentDir: string, candidatePath: string): boolean {
  const relative = path.relative(parentDir, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export const companionLinkCommandDeps = {
  runCompanionLinkCommandWithDeps: (argv: string[]) => runCompanionLinkCommandWithDeps(argv),
};

export async function runCompanionLinkCommand(argv: string[]): Promise<void> {
  return companionLinkCommandDeps.runCompanionLinkCommandWithDeps(argv);
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
  const listCompanions =
    deps.listCompanions ??
    (() => {
      const globalConfigStore = new GlobalConfigStore();
      return globalConfigStore.list.bind(globalConfigStore);
    })();
  const resolveCompanion =
    deps.resolveCompanion ??
    (() => {
      const globalConfigStore = new GlobalConfigStore();
      const resolver = new CompanionResolver(globalConfigStore);
      return resolver.resolve.bind(resolver);
    })();
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
  const existingMatch = await resolveCompanion(cwd);
  const companionsDir = companionsHomeDir();
  const candidatePaths = new Set(await listCompanions());
  if (existingMatch) candidatePaths.add(existingMatch.companionPath);
  const existingCompanions = (
    await Promise.all(
      [...candidatePaths].map(async (candidate) => {
        const companionPath = path.resolve(candidate);
        if (companionPath === cwd) return null;
        if (!isInsideDir(companionsDir, companionPath)) return null;
        const target = await stat(companionPath).catch(() => null);
        return target?.isDirectory() ? companionPath : null;
      }),
    )
  ).filter((candidate): candidate is string => candidate !== null);

  const inputs = await selectInputs({
    existingCompanions,
  });
  if (!inputs) {
    exitWithError("Aborted.");
  }

  const companionSource = inputs.source;
  let companionPaths: string[];

  if (companionSource === "git") {
    const gitUrl = inputs.gitUrl ?? "";
    const repoName = extractName(gitUrl);
    if (!repoName) {
      exitWithError(`mate: could not extract repository name from URL: ${gitUrl}`);
    }

    const companionPath = path.join(companionsDir, repoName);

    const existingTarget = await stat(companionPath).catch(() => null);
    if (!existingTarget?.isDirectory()) {
      await mkdir(companionsDir, { recursive: true });
      const clone = await cloneCompanion(gitUrl, companionPath);
      if (clone.status !== 0) {
        const detail = describeGitFailure(clone);
        exitWithError(
          `mate: failed to clone companion repository:\n${
            detail === "unknown Git error" ? "review the Git or SSH diagnostics above" : detail
          }`,
        );
      }
    }
    companionPaths = [companionPath];
  } else if (companionSource === "existing") {
    if (!inputs.companionPaths?.length) {
      exitWithError("mate: no existing companion was selected.");
    }
    companionPaths = inputs.companionPaths.map((rawCompanionPath) =>
      path.resolve(rawCompanionPath),
    );
    const targets = await Promise.all(
      companionPaths.map((companionPath) => stat(companionPath).catch(() => null)),
    );
    const notADirectory = companionPaths.find((_, index) => !targets[index]?.isDirectory());
    if (notADirectory) {
      exitWithError(`mate: existing companion must be a directory: ${notADirectory}`);
    }
  } else {
    const rawCompanionPath = inputs.localPath?.trim();
    if (!rawCompanionPath) {
      exitWithError("mate: no local companion path was provided.");
    }

    const resolvedCompanionPath = path.resolve(rawCompanionPath);
    const existingTarget = await stat(resolvedCompanionPath).catch(() => null);
    if (!existingTarget?.isDirectory()) {
      exitWithError(`mate: local companion must be a directory: ${resolvedCompanionPath}`);
    }
    companionPaths = [resolvedCompanionPath];
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

  // Managed companions are git-backed; explicitly pasted paths retain local provenance.
  const persistedSource: CompanionSource = companionSource === "local" ? "local" : "git";

  let keptId: string | undefined;
  /* oxlint-disable no-await-in-loop -- each companion is set up, linked and installed in turn; a declined install stops the rest */
  for (const companionPath of companionPaths) {
    const preflight = await inspectPreflight(companionPath);
    if (companionSource === "git" && preflight.kind !== "existing-companion") {
      await runSetup(companionPath);
    }

    const kept = await registerRepository(repository, {
      companionPath,
      companionSource: persistedSource,
    });
    keptId ??= kept.id;
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
  }
  console.log(`  Source: ${persistedSource}`);
  console.log("  Workspace: run `mate companion open` to open the workspace in your editor");
}
