import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isChangeName } from "../../change-layout";
import { pathIsDirectory } from "../../fs-utils";
import type { RunOpenSpec } from "../../openspec-cli";
import { FRAMEWORK_NAME } from "../../../framework";
import {
  companionGit,
  describeGitFailure,
  LITERAL_PATHSPECS,
  type CompanionGit,
} from "../../../runtime/companion-git";
import { errorMessage } from "../../../runtime/error-message";
import { inboxText } from "../../../runtime/pending-records";
import { declaredDependencies } from "../overlap";
import { isCommitId, readDeliveryRecord } from "../record";
import {
  applyChain,
  describeFailure,
  failureRemedy,
  isChainFailure,
  type AppliedChain,
  type ChainFailure,
} from "./apply-chain";
import { sourceDir, type ArtifactType } from "./artifact-type";
import {
  deltaBase,
  orderByDependencies,
  sourcePathOf,
  submittedAt,
  type SubmittedChange,
} from "./pending";
import {
  anchorsAt,
  defaultRef,
  fetchPendingBranches,
  pendingRef,
  stagingRemote,
  type StagingRemote,
} from "./refs";
import { defaultArtifactType } from "./registry";
import { acceptsBlock } from "./submit";
import { assertNoLinkedContent, WITHOUT_HOOKS, withTemporaryWorktree } from "./worktree";

/** Bound on one projection, the optional fetch included. */
const PROJECTION_BUDGET_MS = 120_000;

/** Where a change of the chain is read from: this checkout or the pending branch. */
export type ChainSource = "local" | "submitted";

export interface ProjectedFile {
  /** Companion-relative path, e.g. `openspec/specs/acme-auth/spec.md`. */
  path: string;
  /** Absolute path of the projected copy. */
  file: string;
  content: string;
}

export interface ProjectionResult {
  status: "ok" | "conflict" | "error";
  change: string;
  /** The `dependsOn` chain applied, in order; changes published already are left out. */
  chain: { name: string; source: ChainSource }[];
  /** Folder holding the projected files; null when nothing was projected. */
  dir: string | null;
  /** The derived files the chain changes, as they read once it is published. */
  files: ProjectedFile[];
  message: string;
}

export interface ProjectDeps {
  git?: (cwd: string) => CompanionGit;
  /** Fetch the default and pending branches first; otherwise the last fetched refs are read. */
  fetch?: boolean;
  runOpenSpec?: RunOpenSpec;
  artifactType?: ArtifactType;
  tmpRoot?: string;
  /** Parent of the folder the projected files are written to; the OS temp directory by default. */
  outRoot?: string;
}

const defaultGit = (cwd: string): CompanionGit =>
  companionGit(cwd, { prompt: "never", budgetMs: PROJECTION_BUDGET_MS });

/** A change a chain run applies, read from this checkout or the pending branch. */
export interface RunMember {
  name: string;
  source: ChainSource;
  dependsOn: string[];
  /** The submitted copy, for its delta base; absent for a local change. */
  submitted?: SubmittedChange;
  /** A blocked change submitted again: when submit accepts the block, the default tip is its base. */
  rebased?: boolean;
}

/** Read from this checkout when `local` (its `dependsOn`) is set, else from `copy`. */
export function runMember(name: string, local: string[] | null, copy?: SubmittedChange): RunMember {
  return {
    name,
    source: local !== null ? "local" : "submitted",
    dependsOn: local ?? copy?.dependsOn ?? [],
    ...(copy ? { submitted: copy } : {}),
  };
}

function failed(change: string, status: "conflict" | "error", message: string): ProjectionResult {
  return { status, change, chain: [], dir: null, files: [], message };
}

/** What a chain run reads: this checkout, and the default and pending branches as last fetched. */
export interface ChainContext {
  companionPath: string;
  type: ArtifactType;
  gitFor: (cwd: string) => CompanionGit;
  git: CompanionGit;
  remote: StagingRemote | null;
  /** The default branch, or `HEAD` without one. */
  baseRef: string;
  /** The changes on the pending branch, in submit order. */
  submitted: SubmittedChange[];
  /** Change names the default branch archived. */
  published: ReadonlySet<string>;
  /** Why the refs are the last fetched ones, as a message suffix; empty otherwise. */
  warning: string;
  tmpRoot?: string;
  /** The `dependsOn` of a change in this checkout; null when it has no folder here. */
  localDependencies: (change: string) => Promise<string[] | null>;
}

/** Reads the {@link ChainContext} of `companionPath`, fetching first with `deps.fetch`. */
export async function chainContext(
  companionPath: string,
  deps: ProjectDeps = {},
): Promise<ChainContext> {
  const type = deps.artifactType ?? defaultArtifactType(deps.runOpenSpec);
  const gitFor = deps.git ?? defaultGit;
  const git = gitFor(companionPath);
  let remote: StagingRemote | null = await stagingRemote(git);
  let warning = "";
  if (remote && deps.fetch) {
    const fetched = await fetchPendingBranches(git, remote);
    if ("error" in fetched) warning = ` (${fetched.error}; read the last fetched state)`;
    else remote = fetched;
  }
  const baseRef =
    remote &&
    (await git.run(["rev-parse", "--verify", "-q", `${defaultRef(remote)}^{commit}`])).status === 0
      ? defaultRef(remote)
      : "HEAD";
  const submitted = remote ? await submittedAt(git, pendingRef(remote), type, deps.tmpRoot) : [];
  const published = new Set((await anchorsAt(git, baseRef, type)).map((id) => type.recordName(id)));
  return {
    companionPath,
    type,
    gitFor,
    git,
    remote,
    baseRef,
    submitted,
    published,
    warning,
    ...(deps.tmpRoot ? { tmpRoot: deps.tmpRoot } : {}),
    localDependencies: async (change) => {
      const dir = sourceDir(companionPath, type, change);
      return (await pathIsDirectory(dir)) ? declaredDependencies(dir) : null;
    },
  };
}

/**
 * - `missing`: a dependency is neither here, submitted nor published; nothing was applied
 * - `empty`: nothing to apply
 * - `conflict`: publication would refuse the run, for `failure`
 */
export type ChainRun<T> =
  | { status: "missing"; missing: string[] }
  | { status: "empty" }
  | {
      status: "conflict";
      chain: ProjectionResult["chain"];
      failure: ChainFailure;
      branch: string;
    }
  | { status: "ok"; chain: ProjectionResult["chain"]; value: T };

/**
 * Applies, in a temporary worktree of the default branch and with publication's apply code, the
 * unpublished `dependsOn` chain `dependencies` reach, then `members` as publication orders a
 * group: `dependsOn` among them, then their given order. Neither `members` nor `exclude` join
 * the chain. `onApplied` reads the worktree before it is removed. Commits and pushes nothing.
 */
export async function runChain<T>(
  context: ChainContext,
  input: {
    dependencies: readonly string[];
    members?: readonly RunMember[];
    exclude?: readonly string[];
  },
  onApplied: (dir: string, applied: AppliedChain) => Promise<T>,
): Promise<ChainRun<T>> {
  const { companionPath, type, gitFor, git, remote, baseRef } = context;
  const members = orderByDependencies(input.members ?? []);
  const exclude = new Set([...(input.exclude ?? []), ...members.map((member) => member.name)]);
  const { chain, missing } = await collectChain(
    exclude,
    input.dependencies,
    context.submitted,
    context.published,
    context.localDependencies,
  );
  if (missing.length > 0) return { status: "missing", missing };
  const ordered = orderByDependencies(chain);
  const reported = ordered.map((member) => ({ name: member.name, source: member.source }));
  const applying = [...ordered, ...members];
  if (applying.length === 0) return { status: "empty" };

  return withTemporaryWorktree(
    companionPath,
    baseRef,
    async (dir): Promise<ChainRun<T>> => {
      const work = gitFor(dir);
      const start = (await work.run(["rev-parse", "HEAD"])).stdout.trim();
      const pending = remote ? pendingRef(remote) : null;
      await stageChain(work, companionPath, dir, type, applying, pending);
      // A scaffold commit the stale check reads the chain from; it never leaves this worktree.
      await work.run(["add", "-f", "-A"]);
      const scaffold = await work.run([
        ...WITHOUT_HOOKS,
        "-c",
        "user.name=Mate",
        "-c",
        "user.email=mate@localhost",
        "commit",
        "--allow-empty",
        "-q",
        "-m",
        "projection",
      ]);
      if (scaffold.status !== 0) throw new Error(describeGitFailure(scaffold));
      // The worktree checked only the base; the pending branch's folders arrived since.
      await assertNoLinkedContent(work, "HEAD", [type], "the projected chain");
      const baseOf = async (member: RunMember): Promise<string | null> => {
        if (member.submitted && remote && pending) {
          return deltaBase(git, defaultRef(remote), pending, member.submitted, type);
        }
        const record = await readDeliveryRecord(sourceDir(dir, type, member.name)).catch(
          () => null,
        );
        const base = record?.specBase;
        if (!base || !isCommitId(base)) return null;
        const held = await work.run(["merge-base", "--is-ancestor", base, start]);
        return held.status === 0 ? base : null;
      };
      const bases = await Promise.all(
        applying.map(async (member) => {
          const base = await baseOf(member);
          const folder = sourcePathOf(type, member.name);
          // Submit then moves the base to the tip, as it does for an accepted block.
          const accepted =
            base !== null &&
            member.rebased === true &&
            (await acceptsBlock(type, work, "HEAD", folder, base, start));
          return accepted ? null : base;
        }),
      );
      const applied = await applyChain({
        type,
        work,
        dir,
        members: applying.map((member, index) => ({
          name: member.name,
          base: bases[index] ?? null,
        })),
        ref: "HEAD",
        start,
      });
      if (isChainFailure(applied)) {
        const branch = remote?.defaultBranch ?? "the default branch";
        return { status: "conflict", chain: reported, failure: applied, branch };
      }
      return { status: "ok", chain: reported, value: await onApplied(dir, applied) };
    },
    { git: gitFor, types: [type], ...(context.tmpRoot ? { tmpRoot: context.tmpRoot } : {}) },
  );
}

/**
 * The canonical files as they will read once change `name`'s `dependsOn` chain is published:
 * the chain, from this checkout or the pending branch, is applied in dependency order in a
 * temporary worktree of the default branch with publication's apply code, and the files it
 * changes are copied to a temporary folder. Commits and pushes nothing and leaves the checkout
 * untouched; a chain publication would refuse fails with publication's reason. Never throws.
 */
export async function projectChange(
  companionPath: string,
  name: string,
  deps: ProjectDeps = {},
): Promise<ProjectionResult> {
  if (!isChangeName(name)) return failed(name, "error", `mate: "${name}" is no change name.`);
  try {
    return await project(companionPath, name, deps);
  } catch (error) {
    return failed(name, "error", `mate: projecting ${name} failed. ${errorMessage(error)}`);
  }
}

async function project(
  companionPath: string,
  name: string,
  deps: ProjectDeps,
): Promise<ProjectionResult> {
  const context = await chainContext(companionPath, deps);
  const { type, warning } = context;
  const own =
    (await context.localDependencies(name)) ??
    context.submitted.find((change) => change.name === name)?.dependsOn ??
    null;
  if (own === null) {
    return failed(name, "error", `mate: no change named ${name} here or on the pending branch.`);
  }

  const run = await runChain(context, { dependencies: own, exclude: [name] }, (dir, applied) => {
    const derived = applied.changed.filter(
      (file) =>
        !file.startsWith(`${type.source}/`) &&
        (type.archiveRoot === undefined || !file.startsWith(`${type.archiveRoot}/`)),
    );
    return writeProjection(dir, derived, deps.outRoot ?? os.tmpdir());
  });
  if (run.status === "missing") {
    return failed(
      name,
      "error",
      `mate: ${name} depends on ${run.missing.map(inboxText).join(", ")}, which is neither here, submitted nor published.`,
    );
  }
  if (run.status === "empty") {
    return {
      status: "ok",
      change: name,
      chain: [],
      dir: null,
      files: [],
      message: `${name} depends on no unpublished change; the canonical files apply as they are.${warning}`,
    };
  }

  if (run.status === "conflict") {
    return {
      ...failed(
        name,
        "conflict",
        `mate: ${name}'s dependencies cannot be published: ${describeFailure(run.failure, run.branch)}. ${failureRemedy(run.failure)}`,
      ),
      chain: run.chain,
    };
  }
  const { chain } = run;
  const { out, files } = run.value;
  return {
    status: "ok",
    change: name,
    chain,
    dir: out,
    files,
    message: `Projected ${files.length} file${files.length === 1 ? "" : "s"} once ${chain.map((member) => member.name).join(", ")} ${chain.length === 1 ? "is" : "are"} published, in ${out}.${warning}`,
  };
}

/**
 * The unpublished changes `dependencies` reach, transitively and depth first, and those found
 * neither here, submitted nor published. A submitted change also present here is read locally.
 * Those in `exclude` are passed over.
 */
async function collectChain(
  exclude: ReadonlySet<string>,
  dependencies: readonly string[],
  submitted: readonly SubmittedChange[],
  published: ReadonlySet<string>,
  localDependencies: (change: string) => Promise<string[] | null>,
): Promise<{ chain: RunMember[]; missing: string[] }> {
  const chain: RunMember[] = [];
  const missing: string[] = [];
  const visit = async (next: readonly string[]): Promise<void> => {
    for (const dependency of next) {
      if (exclude.has(dependency) || chain.some((member) => member.name === dependency)) continue;
      if (missing.includes(dependency)) continue;
      const copy = submitted.find((change) => change.name === dependency);
      // oxlint-disable-next-line no-await-in-loop -- a short chain
      const local = await localDependencies(dependency);
      if (!copy && published.has(dependency)) continue;
      if (!copy && local === null) {
        missing.push(dependency);
        continue;
      }
      const member = runMember(dependency, local, copy);
      chain.push(member);
      // oxlint-disable-next-line no-await-in-loop -- depth first
      await visit(member.dependsOn);
    }
  };
  await visit(dependencies);
  return { chain, missing };
}

/** Puts each member's folder into worktree `dir`: copied from this checkout or read from `pending`. */
async function stageChain(
  work: CompanionGit,
  companionPath: string,
  dir: string,
  type: ArtifactType,
  ordered: readonly RunMember[],
  pending: string | null,
): Promise<void> {
  for (const member of ordered) {
    const target = sourceDir(dir, type, member.name);
    if (member.source === "local") {
      // oxlint-disable-next-line no-await-in-loop -- one folder at a time
      await fs.rm(target, { recursive: true, force: true });
      // oxlint-disable-next-line no-await-in-loop -- same folder
      await fs.cp(sourceDir(companionPath, type, member.name), target, {
        recursive: true,
        verbatimSymlinks: true,
      });
    } else {
      // A folder committed while active goes first: a file the submitted one dropped must not stay.
      // oxlint-disable-next-line no-await-in-loop -- same folder
      await work.run([
        ...LITERAL_PATHSPECS,
        "rm",
        "-r",
        "-q",
        "--ignore-unmatch",
        "--",
        member.submitted!.path,
      ]);
      // Without hooks: `post-checkout` would run on a teammate's pending tree.
      // oxlint-disable-next-line no-await-in-loop -- same folder
      const read = await work.run([
        ...WITHOUT_HOOKS,
        ...LITERAL_PATHSPECS,
        "checkout",
        "-q",
        pending!,
        "--",
        member.submitted!.path,
      ]);
      if (read.status !== 0) throw new Error(describeGitFailure(read));
    }
  }
}

const PROJECTION_PREFIX = `${FRAMEWORK_NAME}-projection-`;

/** How long a projection folder is kept: read right after the command, it holds unpublished specs. */
const PROJECTION_KEEP_MS = 60 * 60 * 1000;

/** Removes this user's projection folders below `outRoot` older than {@link PROJECTION_KEEP_MS}. */
async function removeOldProjections(outRoot: string): Promise<void> {
  const entries = await fs.readdir(outRoot, { withFileTypes: true }).catch(() => []);
  const uid = process.getuid?.();
  const oldest = Date.now() - PROJECTION_KEEP_MS;
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(PROJECTION_PREFIX))
      .map(async (entry) => {
        const dir = path.join(outRoot, entry.name);
        const stat = await fs.lstat(dir).catch(() => null);
        if (!stat?.isDirectory() || stat.mtimeMs > oldest) return;
        if (uid !== undefined && stat.uid !== uid) return;
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }),
  );
}

/**
 * Copies the `derived` files of worktree `dir` into a new folder below `outRoot`; earlier
 * projections there that have aged out are removed.
 */
async function writeProjection(
  dir: string,
  derived: readonly string[],
  outRoot: string,
): Promise<{ out: string; files: ProjectedFile[] }> {
  await removeOldProjections(outRoot);
  const out = await fs.mkdtemp(path.join(outRoot, PROJECTION_PREFIX));
  const files: ProjectedFile[] = [];
  for (const file of derived) {
    const target = path.join(out, ...file.split("/"));
    // oxlint-disable-next-line no-await-in-loop -- a handful of files
    const content = await fs.readFile(path.join(dir, ...file.split("/")), "utf8");
    // oxlint-disable-next-line no-await-in-loop -- same file
    await fs.mkdir(path.dirname(target), { recursive: true });
    // oxlint-disable-next-line no-await-in-loop -- same file
    await fs.writeFile(target, content);
    files.push({ path: file, file: target, content });
  }
  return { out, files };
}
