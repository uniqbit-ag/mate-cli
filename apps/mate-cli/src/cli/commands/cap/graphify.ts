import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveForCapability } from "../../../lib/orchestrator/framework-context";
import type { CapabilityConfig } from "../../../lib/orchestrator/types";
import {
  GRAPHIFY_OUTPUT_SUBDIR,
  GRAPHIFY_STORE_SEGMENT,
} from "../../../tools/setup/capabilities/graphify";
import { ensureUnambiguousCompanion } from "../shared/companion-selection";

export interface GraphifyPaths {
  graphifyOut: string;
  graphJson: string;
}

export interface GraphifyCapDeps {
  ensureUnambiguousCompanion?: (cwd: string) => Promise<boolean>;
}

const GRAPHIFY_PATH_COMMANDS = new Set([
  "extract",
  "watch",
  "cluster-only",
  "label",
  "check-update",
]);

const GRAPHIFY_GRAPH_COMMANDS = new Set(["query", "path", "explain", "affected", "tree"]);

export function deriveGraphifyPaths(companionPath: string, repositoryId: string): GraphifyPaths {
  const graphifyOut = path.join(
    companionPath,
    GRAPHIFY_STORE_SEGMENT,
    repositoryId,
    GRAPHIFY_OUTPUT_SUBDIR,
  );

  return {
    graphifyOut,
    graphJson: path.join(graphifyOut, "graph.json"),
  };
}

function hasGraphArg(args: string[]): boolean {
  return args.some((arg) => arg === "--graph" || arg === "-g" || arg.startsWith("--graph="));
}

function hasOutArg(args: string[]): boolean {
  return args.some((arg) => arg === "--out" || arg.startsWith("--out="));
}

function normalizeCompatibilityAlias(subcommand: string | undefined): string | undefined {
  if (subcommand === "build") return "extract";
  if (subcommand === "lookup") return "query";
  return subcommand;
}

function normalizeCompatibilityArgs(subcommand: string | undefined, args: string[]): string[] {
  if (subcommand !== "build") return args;

  return args.map((arg) => {
    if (arg === "--output") return "--out";
    if (arg.startsWith("--output=")) return `--out=${arg.slice("--output=".length)}`;
    return arg;
  });
}

function injectDefaultRepoPath(
  command: string | undefined,
  args: string[],
  repoPath: string,
): string[] {
  if (!command || !GRAPHIFY_PATH_COMMANDS.has(command)) return args;
  if (args.length === 0 || args[0]?.startsWith("-")) {
    return [repoPath, ...args];
  }

  return args;
}

function injectDefaultOut(
  command: string | undefined,
  args: string[],
  paths: GraphifyPaths,
): string[] {
  if (command !== "extract" || hasOutArg(args)) return args;
  if (args.length === 0) return [".", "--out", path.dirname(paths.graphifyOut)];

  return [args[0], "--out", path.dirname(paths.graphifyOut), ...args.slice(1)];
}

function injectDefaultGraph(
  command: string | undefined,
  args: string[],
  paths: GraphifyPaths,
): string[] {
  if (!command || !GRAPHIFY_GRAPH_COMMANDS.has(command) || hasGraphArg(args)) return args;
  return [...args, "--graph", paths.graphJson];
}

export function deriveGraphifyCommandArgs(
  args: string[],
  repoPath: string,
  paths: GraphifyPaths,
): string[] {
  const [rawSubcommand, ...rawRest] = args;

  const subcommand = normalizeCompatibilityAlias(rawSubcommand);

  if (!subcommand) return args;

  let commandArgs = normalizeCompatibilityArgs(rawSubcommand, rawRest);
  commandArgs = injectDefaultRepoPath(subcommand, commandArgs, repoPath);
  commandArgs = injectDefaultOut(subcommand, commandArgs, paths);
  commandArgs = injectDefaultGraph(subcommand, commandArgs, paths);

  return [subcommand, ...commandArgs];
}

/**
 * @command mate cap graphify [...args]
 * @description Forwards `[...args]` to the `graphify` CLI, scoped to the
 * active working repository. Requires the `graphify` capability to be enabled
 * in `.mate/config/framework.yaml` and a registered working repo for the
 * current `MATE_REPO_ID`. Rewrites legacy subcommand aliases (`build` → `extract`,
 * `lookup` → `query`) and injects sensible defaults via
 * {@link deriveGraphifyCommandArgs}: the repo path as the first positional arg
 * for path-taking commands, `--out <graphifyOut>` for `extract`, and
 * `--graph <graphJson>` for graph-reading commands (`query`, `path`, `explain`,
 * `affected`, `tree`) — unless the caller already supplied one.
 * @remarks The child process's exit code is propagated via `process.exitCode`.
 */
export async function runGraphifyCapCommand(
  args: string[],
  deps: GraphifyCapDeps = {},
): Promise<void> {
  const ensureCompanion = deps.ensureUnambiguousCompanion ?? ensureUnambiguousCompanion;
  if (!(await ensureCompanion(process.cwd()))) {
    process.exitCode = 1;
    return;
  }

  const { companionPath, repositoryId, repository, configStore, workingRepoStore } =
    await resolveForCapability(process.cwd());
  const config = await configStore.load();

  const capability = (config.capabilities ?? []).find(
    (entry: CapabilityConfig) => entry.name === "graphify",
  );
  if (!capability) {
    process.stderr.write("graphify capability is not enabled in .mate/config/framework.yaml\n");
    process.exitCode = 1;
    return;
  }

  const repo =
    repository ?? (await workingRepoStore.load()).repos.find((entry) => entry.id === repositoryId);
  if (!repo) {
    process.stderr.write(`mate: no working repo found for id ${repositoryId}\n`);
    process.exitCode = 1;
    return;
  }

  const paths = deriveGraphifyPaths(companionPath, repositoryId);
  const commandArgs = deriveGraphifyCommandArgs(args, repo.path, paths);

  if (commandArgs[0] === "extract") {
    await fs.mkdir(paths.graphifyOut, { recursive: true });
  }

  const result = spawnSync("graphify", commandArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      GRAPHIFY_OUT: paths.graphifyOut,
    },
  });
  if (result.error) {
    process.stderr.write(`Failed to run graphify: ${result.error.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (result.status !== null) {
    process.exitCode = result.status;
  }
}
