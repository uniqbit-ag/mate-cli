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
import { applyChain, describeFailure, failureRemedy, isChainFailure } from "./apply-chain";
import { sourceDir, type ArtifactType } from "./artifact-type";
import { deltaBase, orderByDependencies, submittedAt, type SubmittedChange } from "./pending";
import {
  anchorsAt,
  defaultRef,
  fetchPendingBranches,
  pendingRef,
  stagingRemote,
  type StagingRemote,
} from "./refs";
import { defaultArtifactType } from "./registry";
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

interface ChainMember {
  name: string;
  source: ChainSource;
  dependsOn: string[];
  /** The submitted copy, for its delta base; absent for a local change. */
  submitted?: SubmittedChange;
}

function failed(change: string, status: "conflict" | "error", message: string): ProjectionResult {
  return { status, change, chain: [], dir: null, files: [], message };
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

  const localDependencies = async (change: string): Promise<string[] | null> => {
    const dir = sourceDir(companionPath, type, change);
    return (await pathIsDirectory(dir)) ? declaredDependencies(dir) : null;
  };
  const own =
    (await localDependencies(name)) ??
    submitted.find((change) => change.name === name)?.dependsOn ??
    null;
  if (own === null) {
    return failed(name, "error", `mate: no change named ${name} here or on the pending branch.`);
  }

  const { chain, missing } = await collectChain(name, own, submitted, published, localDependencies);
  if (missing.length > 0) {
    return failed(
      name,
      "error",
      `mate: ${name} depends on ${missing.map(inboxText).join(", ")}, which is neither here, submitted nor published.`,
    );
  }
  const ordered = orderByDependencies(chain);
  const reported = ordered.map((member) => ({ name: member.name, source: member.source }));
  if (ordered.length === 0) {
    return {
      status: "ok",
      change: name,
      chain: [],
      dir: null,
      files: [],
      message: `${name} depends on no unpublished change; the canonical files apply as they are.${warning}`,
    };
  }

  return withTemporaryWorktree(
    companionPath,
    baseRef,
    async (dir) => {
      const work = gitFor(dir);
      const start = (await work.run(["rev-parse", "HEAD"])).stdout.trim();
      const pending = remote ? pendingRef(remote) : null;
      await stageChain(work, companionPath, dir, type, ordered, pending);
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
      const bases = await Promise.all(
        ordered.map(async (member) => {
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
        }),
      );
      const applied = await applyChain({
        type,
        work,
        dir,
        members: ordered.map((member, index) => ({
          name: member.name,
          base: bases[index] ?? null,
        })),
        ref: "HEAD",
        start,
      });
      if (isChainFailure(applied)) {
        const branch = remote?.defaultBranch ?? "the default branch";
        return {
          ...failed(
            name,
            "conflict",
            `mate: ${name}'s dependencies cannot be published: ${describeFailure(applied, branch)}. ${failureRemedy(applied)}`,
          ),
          chain: reported,
        };
      }
      const derived = applied.changed.filter(
        (file) => !file.startsWith(`${type.source}/`) && !file.startsWith(`${type.archiveRoot}/`),
      );
      const { out, files } = await writeProjection(dir, derived, deps.outRoot ?? os.tmpdir());
      return {
        status: "ok",
        change: name,
        chain: reported,
        dir: out,
        files,
        message: `Projected ${files.length} file${files.length === 1 ? "" : "s"} once ${reported.map((member) => member.name).join(", ")} ${reported.length === 1 ? "is" : "are"} published, in ${out}.${warning}`,
      };
    },
    { git: gitFor, types: [type], ...(deps.tmpRoot ? { tmpRoot: deps.tmpRoot } : {}) },
  );
}

/**
 * The unpublished changes `dependencies` reach, transitively and depth first, and those found
 * neither here, submitted nor published. A submitted change also present here is read locally.
 */
async function collectChain(
  name: string,
  dependencies: readonly string[],
  submitted: readonly SubmittedChange[],
  published: ReadonlySet<string>,
  localDependencies: (change: string) => Promise<string[] | null>,
): Promise<{ chain: ChainMember[]; missing: string[] }> {
  const chain: ChainMember[] = [];
  const missing: string[] = [];
  const visit = async (next: readonly string[]): Promise<void> => {
    for (const dependency of next) {
      if (dependency === name || chain.some((member) => member.name === dependency)) continue;
      const copy = submitted.find((change) => change.name === dependency);
      // oxlint-disable-next-line no-await-in-loop -- a short chain
      const local = await localDependencies(dependency);
      if (!copy && published.has(dependency)) continue;
      if (!copy && local === null) {
        missing.push(dependency);
        continue;
      }
      const member: ChainMember = {
        name: dependency,
        source: local !== null ? "local" : "submitted",
        dependsOn: local ?? copy!.dependsOn,
        ...(copy ? { submitted: copy } : {}),
      };
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
  ordered: readonly ChainMember[],
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
