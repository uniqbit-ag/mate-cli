import { resolveForCapability } from "../../../../lib/orchestrator/framework-context";
import type { LaunchContext } from "../../../../lib/orchestrator/framework-context";
import type { CapabilityConfig } from "../../../../lib/orchestrator/types";
import { WorkingRepoRequiredError } from "../../../../lib/orchestrator/types";
import { parseFlags } from "../../../parse-flags";
import { ensureUnambiguousCompanion } from "../../shared/companion-selection";
import { runFinishEngine } from "./engine";
import type { FinishContext, FinisherFactory } from "./finisher";
import { defaultGitOps, type GitOps } from "./git";
import { DEFAULT_FINISHER_TYPE, knownFinisherTypes, selectFinisher } from "./registry";

export interface FinishCommandDeps {
  ensureUnambiguousCompanion?: (cwd: string) => Promise<boolean>;
  resolveContext?: (cwd: string) => Promise<LaunchContext>;
  loadCapabilities?: (context: LaunchContext) => Promise<CapabilityConfig[]>;
  selectFinisher?: (type: string) => FinisherFactory | undefined;
  git?: (companionPath: string, workingRepoPath?: string) => GitOps;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const VALUE_FLAGS = new Set(["--type"]);

/** First non-flag token, skipping the value of any value-taking flag (e.g. `--type x`). */
function positionalName(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (VALUE_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("--")) continue;
    return token;
  }
  return undefined;
}

async function defaultLoadCapabilities(context: LaunchContext): Promise<CapabilityConfig[]> {
  const config = await context.configStore.load();
  return config.capabilities ?? [];
}

/**
 * @command mate artifact finish <name>
 * @description Finishes and archives a completed artifact/change named `<name>`.
 * Resolves the launch context for the current working repo, loads the enabled
 * capabilities, selects a {@link FinisherFactory} for `--type` (defaulting to
 * `DEFAULT_FINISHER_TYPE`, e.g. an OpenSpec change), and — if that finisher is
 * enabled for this repo's capabilities — runs {@link runFinishEngine} to
 * validate, produce, and commit/push the finish artifacts via {@link GitOps}.
 * @flags
 * - `<name>` — required positional: the change/artifact name to finish.
 * - `--type <type>` — finisher type to use; see `knownFinisherTypes()`.
 * - `--force` — bypass the completion guard; unrelated companion work is always preserved.
 * - `--no-push` — commit locally but skip pushing.
 * - `--json` — emit machine-readable JSON result instead of human-readable text.
 * @remarks No-ops (with a message on stderr) when the selected finisher is
 * disabled for the repo's configured capabilities — nothing is validated,
 * produced, or mutated in that case.
 */
export async function runArtifactFinishCommand(
  argv: string[],
  deps: FinishCommandDeps = {},
): Promise<void> {
  const emitOut = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emitErr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  const flags = parseFlags(argv);
  const force = flags.force === true;
  const noPush = flags["no-push"] === true;
  const json = flags.json === true;
  const type = typeof flags.type === "string" ? flags.type : DEFAULT_FINISHER_TYPE;
  const name = positionalName(argv);

  if (!name) {
    emitErr("mate: artifact finish requires a change name.");
    process.exitCode = 1;
    return;
  }

  const selectFinisherFn = deps.selectFinisher ?? selectFinisher;
  const finisherFactory = selectFinisherFn(type);
  if (!finisherFactory) {
    emitErr(
      `mate: unknown artifact type "${type}". Known types: ${knownFinisherTypes().join(", ")}.`,
    );
    process.exitCode = 1;
    return;
  }

  const ensureCompanion = deps.ensureUnambiguousCompanion ?? ensureUnambiguousCompanion;
  if (!(await ensureCompanion(process.cwd()))) {
    process.exitCode = 1;
    return;
  }

  const resolveContext = deps.resolveContext ?? ((cwd: string) => resolveForCapability(cwd));
  let context: LaunchContext;
  try {
    context = await resolveContext(process.cwd());
  } catch (err) {
    if (err instanceof WorkingRepoRequiredError) {
      emitErr(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const loadCapabilities = deps.loadCapabilities ?? defaultLoadCapabilities;
  const capabilities = await loadCapabilities(context);

  const finishContext: FinishContext = {
    companionPath: context.companionPath,
    repositoryId: context.repositoryId,
    repository: context.repository,
  };
  const finisher = finisherFactory(finishContext);
  if (!finisher.isEnabled(capabilities)) {
    // No-op with message: nothing was validated, produced, or mutated.
    emitErr(finisher.disabledReason);
    return;
  }

  let git: GitOps;
  try {
    git = (deps.git ?? defaultGitOps)(
      context.companionPath,
      context.repository?.path ?? process.env.MATE_REPO_PATH,
    );
  } catch (err) {
    const message = `mate: finish Git guard rejected the target: ${String(err)}`;
    if (json) {
      emitOut(
        JSON.stringify({
          type,
          name,
          anchorName: null,
          tag: null,
          resumed: false,
          step: "commit",
          status: "error",
          conflictedPaths: [],
          local: { committed: false, tagged: false, pushed: false },
          message,
        }),
      );
    } else {
      emitErr(message);
    }
    process.exitCode = 1;
    return;
  }

  await runFinishEngine(
    finisher,
    { name, force, noPush },
    { git, json, stdout: emitOut, stderr: emitErr },
  );
}
