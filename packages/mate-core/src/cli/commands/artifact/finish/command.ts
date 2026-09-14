import { resolveForCapability } from "../../../../lib/orchestrator/framework-context";
import type { LaunchContext } from "../../../../lib/orchestrator/framework-context";
import type { CapabilityConfig } from "../../../../lib/orchestrator/types";
import { WorkingRepoRequiredError } from "../../../../lib/orchestrator/types";
import { type BooleanFlagSet, parseFlags } from "../../../parse-flags";
import { ensureUnambiguousCompanion } from "../../shared/companion-selection";
import { discoverArchives, pendingArchives } from "../pending/discovery";
import { type FinishResult, runFinishEngine } from "./engine";
import type { ArtifactFinisher, FinishContext, FinisherFactory } from "./finisher";
import { defaultGitOps, type GitOps } from "./git";
import { openspecSpecsFinisher, resolveDriftedSpecs } from "./openspec";
import { DEFAULT_FINISHER_TYPE, knownFinisherTypes, selectFinisher } from "./registry";

export interface PublishCommandDeps {
  ensureUnambiguousCompanion?: (cwd: string) => Promise<boolean>;
  resolveContext?: (cwd: string) => Promise<LaunchContext>;
  loadCapabilities?: (context: LaunchContext) => Promise<CapabilityConfig[]>;
  selectFinisher?: (type: string) => FinisherFactory | undefined;
  git?: (companionPath: string, workingRepoPath?: string) => GitOps;
  /** Injectable clock; a spec publication's anchor is the calendar date it runs on. */
  now?: () => Date;
  /** Injectable spec-publication finisher; mirrors `selectFinisher` for the other unit. */
  specsFinisher?: (context: FinishContext, paths: string[], now: () => Date) => ArtifactFinisher;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** Presence-only flags; every other `--flag` consumes the following token as its value. */
const BOOLEAN_FLAGS: BooleanFlagSet = new Set(["no-push", "json", "specs", "all"]);

/**
 * Every non-flag token, in order. Consumes the value of a value-taking flag exactly as
 * {@link parseFlags} does, so the positionals and the flags can never disagree about
 * which token belongs to whom.
 */
function positionalNames(argv: string[]): string[] {
  const names: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      names.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key.includes("=") || BOOLEAN_FLAGS.has(key)) continue;
    index += 1;
  }
  return names;
}

async function defaultLoadCapabilities(context: LaunchContext): Promise<CapabilityConfig[]> {
  const config = await context.configStore.load();
  return config.capabilities ?? [];
}

/** A publication the pipeline never ran: nothing was resolved, committed, tagged, or pushed. */
function nothingToPublish(name: string, message: string): FinishResult {
  return {
    type: DEFAULT_FINISHER_TYPE,
    name,
    anchorName: null,
    tag: null,
    resumed: false,
    step: "done",
    status: "skipped",
    conflictedPaths: [],
    local: { committed: false, tagged: false, pushed: false },
    message,
  };
}

function refusalResult(type: string, name: string, message: string): FinishResult {
  return {
    type,
    name,
    anchorName: null,
    tag: null,
    resumed: false,
    step: "resolve",
    status: "error",
    conflictedPaths: [],
    local: { committed: false, tagged: false, pushed: false },
    message,
  };
}

/**
 * @command mate artifact publish <target>
 * @description Publishes an already-produced artifact. Resolves the launch context for the
 * current working repo, loads the enabled capabilities, and runs {@link runFinishEngine} to
 * commit/tag/push via {@link GitOps}. Two publication units exist: an archived change,
 * named positionally, and a spec publication of drifted canonical specs, selected with
 * `--specs`. Archiving is a precondition performed by the archive workflow; this command
 * never archives.
 * @flags
 * - `<target>` — a dated archive anchor (`YYYY-MM-DD-<name>`), or a change name matching
 *   exactly one archive. Mutually exclusive with `--specs` and `--all`.
 * - `--specs [<path>...]` — publish drifted canonical specs as their own publication under a
 *   new `openspec/specs/<date>-<specs>` tag. Bare, it publishes every drifted spec; with paths, only
 *   those. A bare name alongside it is a change target and is refused.
 * - `--all` — publish every pending change in discovery order, then one spec publication for
 *   the drift that remains. Halts at the first conflict or error; with `--json` it emits a
 *   single array of results in execution order.
 * - `--type <type>` — finisher type to use; see `knownFinisherTypes()`. `--specs` and
 *   `--all` are openspec-only.
 * - `--no-push` — commit and tag locally but skip the remote sync and push.
 * - `--json` — emit machine-readable JSON instead of human-readable text.
 * @remarks No-ops (with a message on stderr) when the selected finisher is disabled for the
 * repo's configured capabilities — nothing is resolved or mutated in that case.
 */
export async function runArtifactPublishCommand(
  argv: string[],
  deps: PublishCommandDeps = {},
): Promise<void> {
  const emitOut = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emitErr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  const flags = parseFlags(argv, BOOLEAN_FLAGS);
  const noPush = flags["no-push"] === true;
  const json = flags.json === true;
  const type = typeof flags.type === "string" ? flags.type : DEFAULT_FINISHER_TYPE;
  const specsMode = flags.specs === true;
  const allMode = flags.all === true;
  const positionals = positionalNames(argv);

  /** With `--specs`, a path narrows the publication; a bare name is a change target. */
  const specPaths = specsMode ? positionals.filter((token) => token.includes("/")) : [];
  const changeTargets = specsMode
    ? positionals.filter((token) => !token.includes("/"))
    : positionals;

  /** Argument refusals go to stderr in every mode: nothing was resolved to report on. */
  const refuse = (message: string): void => {
    emitErr(message);
    process.exitCode = 1;
  };

  if (allMode && (specsMode || positionals.length > 0)) {
    refuse(
      "mate: --all already publishes both pending changes and drifted specs; drop the extra target.",
    );
    return;
  }
  if (specsMode && changeTargets.length > 0) {
    refuse(
      `mate: "${changeTargets[0]}" is a change target and --specs publishes canonical specs; they are different publication units. Pass one or the other.`,
    );
    return;
  }
  if (!allMode && !specsMode && positionals.length === 0) {
    refuse("mate: artifact publish requires an archive anchor or change name, --specs, or --all.");
    return;
  }
  if ((allMode || specsMode) && type !== DEFAULT_FINISHER_TYPE) {
    refuse(`mate: --specs and --all are only available for the ${DEFAULT_FINISHER_TYPE} type.`);
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
    const message = `mate: publish Git guard rejected the target: ${String(err)}`;
    if (json) emitOut(JSON.stringify(refusalResult(type, positionals[0] ?? "", message)));
    else emitErr(message);
    process.exitCode = 1;
    return;
  }

  const now = deps.now ?? (() => new Date());
  /**
   * Under `--all --json` the array is the whole output, so the per-publication emission is
   * suppressed; every other mode lets the engine report each publication as it finishes.
   */
  const quiet = allMode && json;
  const engineDeps = {
    git,
    json: !allMode && json,
    stdout: quiet ? (): void => {} : emitOut,
    stderr: quiet ? (): void => {} : emitErr,
  };

  const runChange = (target: string): Promise<FinishResult> =>
    runFinishEngine(finisher, { name: target, noPush }, engineDeps);

  const runSpecs = async (requested: string[]): Promise<FinishResult | null> => {
    const drift = await resolveDriftedSpecs(context.companionPath, git, requested);
    if (!drift.ok) {
      if (!quiet && !json) emitErr(drift.message);
      process.exitCode = 1;
      return refusalResult(type, "--specs", drift.message);
    }
    if (drift.paths.length === 0) return null;
    const makeSpecsFinisher = deps.specsFinisher ?? openspecSpecsFinisher;
    const specsFinisher = makeSpecsFinisher(finishContext, drift.paths, now);
    return runFinishEngine(specsFinisher, { name: "--specs", noPush }, engineDeps);
  };

  const halted = (result: FinishResult): boolean =>
    result.status === "conflict" || result.status === "error";

  if (allMode) {
    const results: FinishResult[] = [];
    const changed = await git.changedPaths();
    const changeKinds = (await git.changedPathKinds?.()) ?? {};
    const archives = await discoverArchives(context.companionPath, changed, changeKinds);

    for (const entry of pendingArchives(archives)) {
      const result = await runChange(entry.anchor);
      results.push(result);
      if (halted(result)) {
        if (json) emitOut(JSON.stringify(results));
        return;
      }
    }

    /** Drift is recomputed: a spec a change just committed is no longer drifted. */
    const specResult = await runSpecs([]);
    if (specResult) results.push(specResult);

    if (json) emitOut(JSON.stringify(results));
    else if (results.length === 0) emitOut("Nothing to publish.");
    return;
  }

  if (specsMode) {
    const result = await runSpecs(specPaths);
    const emitted =
      result ?? nothingToPublish("--specs", "No drifted canonical specs; nothing to publish.");
    if (json) {
      if (result === null) emitOut(JSON.stringify(emitted));
    } else if (result === null) {
      emitOut(emitted.message);
    }
    return;
  }

  await runChange(positionals[0]);
}
