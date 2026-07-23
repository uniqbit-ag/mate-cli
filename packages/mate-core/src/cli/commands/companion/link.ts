import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";

import { frameworkConfig } from "../../../framework";
import {
  selectCompanionLinkInputs,
  type CompanionLinkInputs,
  type CompanionLinkWizardOptions,
} from "../../companion-link-wizard";
import { extractRepoName } from "../artifact/extract-repo-name";
import { defaultConfig } from "../../../lib/orchestrator/config-store";
import { GlobalConfigStore } from "../../../lib/orchestrator/global-config-store";
import { CompanionResolver } from "../../../lib/orchestrator/companion-resolver";
import { inspectSetupPreflight } from "../../../lib/orchestrator/setup-preflight";
import {
  findDescendantRepoLocalRegistries,
  writeRepoLocalRegistryEntry,
} from "../../../lib/orchestrator/repo-local-registry";
import { runSetupFlowAtPath } from "../setup";
import { runInstallCommand } from "../install";
import type { CompanionSource, LinkedRepository } from "../../../lib/orchestrator/types";
import { invalidateInstallState } from "../../../lib/install";

interface CompanionLinkCommandDeps {
  selectCompanionLinkInputs?: (
    options: CompanionLinkWizardOptions,
  ) => Promise<CompanionLinkInputs | null>;
  extractRepoName?: (url: string) => string | null;
  spawnSync?: typeof spawnSync;
  mkdir?: typeof fs.mkdir;
  stat?: typeof fs.stat;
  rm?: typeof fs.rm;
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

/** All companions surfaced by the "existing companion" picker live under this directory. */
function companionsHomeDir(): string {
  return path.join(os.homedir(), `.${frameworkConfig.name}`, "companions");
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

function toSshUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname || parsed.pathname === "/") return null;

    const repositoryPath = parsed.pathname.replace(/^\/+/, "");
    if (!repositoryPath) return null;

    // Keep the usual scp-style form when no SSH port is specified.
    if (!parsed.port) return `git@${parsed.hostname}:${repositoryPath}`;
    return `ssh://git@${parsed.hostname}:${parsed.port}/${repositoryPath}`;
  } catch {
    return null;
  }
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
  const spawn = deps.spawnSync ?? spawnSync;
  const mkdir = deps.mkdir ?? fs.mkdir;
  const stat = deps.stat ?? fs.stat;
  const rm = deps.rm ?? fs.rm;
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
  const profiles = Object.keys(defaultConfig().profiles);
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
    profiles,
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
      const sshUrl = toSshUrl(gitUrl);
      const cloneUrls = sshUrl && sshUrl !== gitUrl ? [sshUrl, gitUrl] : [gitUrl];
      let cloneResult:
        | {
            status: number | null;
            stderr?: string | Buffer;
            stdout?: string | Buffer;
          }
        | undefined;
      const cloneErrors: string[] = [];

      for (const cloneUrl of cloneUrls) {
        cloneResult = spawn("git", ["clone", cloneUrl, companionPath], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (cloneResult.status === 0) {
          break;
        }

        cloneErrors.push(
          String(cloneResult.stderr || cloneResult.stdout || `Clone failed for ${cloneUrl}`),
        );
        try {
          await rm(companionPath, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors after a failed clone.
        }
      }

      if (!cloneResult || cloneResult.status !== 0) {
        try {
          await rm(companionPath, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors after a failed clone.
        }
        const output = cloneErrors.join("\n\n");
        exitWithError(`mate: failed to clone companion repository:\n${output}`);
      }
    }
    companionPaths = [companionPath];
  } else if (companionSource === "existing") {
    if (!inputs.companionPaths?.length) {
      exitWithError("mate: no existing companion was selected.");
    }
    companionPaths = [];
    for (const rawCompanionPath of inputs.companionPaths) {
      const resolvedCompanionPath = path.resolve(rawCompanionPath);
      const existingTarget = await stat(resolvedCompanionPath).catch(() => null);
      if (!existingTarget?.isDirectory()) {
        exitWithError(`mate: existing companion must be a directory: ${resolvedCompanionPath}`);
      }
      companionPaths.push(resolvedCompanionPath);
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

  const repository: LinkedRepository = {
    id: path.basename(cwd),
    path: cwd,
    profile: inputs.profile,
  };

  const registerRepository =
    deps.registerRepository ??
    (async (nextRepository, options) => {
      await writeRepoLocalRegistryEntry(
        nextRepository.path,
        options.companionPath,
        nextRepository,
        options.companionSource,
      );
      return nextRepository;
    });

  // Managed companions are git-backed; explicitly pasted paths retain local provenance.
  const persistedSource: CompanionSource = companionSource === "local" ? "local" : "git";

  for (const companionPath of companionPaths) {
    const preflight = await inspectPreflight(companionPath);
    if (companionSource === "git" && preflight.kind !== "existing-companion") {
      await runSetup(companionPath);
    }

    await registerRepository(repository, { companionPath, companionSource: persistedSource });
    await registerCompanion(companionPath);
    await invalidateInstallState({ kind: "companion", companionPath });
    if ((await installCompanion(companionPath)) === false) return;
  }

  let shadowedPaths: string[] = [];
  try {
    shadowedPaths = await findShadowedRegistries(cwd);
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

  console.log(`Successfully linked companion for ${repository.id}`);
  for (const companionPath of companionPaths) {
    console.log(`  Companion: ${companionPath}`);
  }
  console.log(`  Source: ${persistedSource}`);
  console.log(`  Profile: ${repository.profile}`);
  console.log("  Workspace: run `mate companion open` to open the workspace in your editor");
}
