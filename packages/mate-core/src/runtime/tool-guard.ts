/**
 * The Tool Guard: the one verdict every Agent Runtime reaches before a tool
 * call. Adapters only translate to {@link GuardedToolCall} and back; they hold
 * no verdict logic.
 *
 * First refusal wins, in order: secret access, commit attribution, artifact
 * path, forked companion. Unreadable calls and guard failures
 * ({@link guardFailureMessage}) are refused: the guard fails closed.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { artifactRefusal, resolveArtifactTarget } from "./artifact-refusal";
import { checkCommitAttribution } from "./commit-attribution-guard";
import { companionForkRefusal } from "./companion-sync";
import {
  absoluteAsWritten,
  foldCase,
  isWithin,
  PATH_SEPARATORS,
  physicalPath,
} from "./physical-path";
import { companionLinkPath } from "./repo-local";
import {
  checkSecretAccess,
  type SecretCheckCall,
  type SecretGuardDeps,
  type SecretTarget,
  type SecretWrite,
} from "./secret-guard";
import { MAX_SHELL_NESTING, readShell, ShellNestingError, writeTargets } from "./shell-reading";

export type WriteMode = "create" | "edit";

/** Runtime-neutral tool call; the Claude hook and OpenCode middleware both translate into it, so they refuse alike. */
export type GuardedToolCall =
  | { kind: "read"; paths: string[] }
  /** `content` is what the call would put into the file: a whole body or an edit's new text. */
  | { kind: "write"; writes: GuardedWrite[] }
  | { kind: "shell"; command: string }
  /** A content search: refused when it names a secret file or a glob aimed at secret files. */
  | { kind: "search"; paths: string[]; globs: string[] };

export interface GuardedWrite {
  path: string;
  content: string;
  mode: WriteMode;
  /**
   * A move's source, which OpenCode writes whole to `path`; `content` then holds
   * the patch's added lines. A companion destination is scanned as the source's
   * content plus those lines. The Tool Guard resolves it against the Working
   * Repository first.
   */
  movedFrom?: string;
}

export interface ToolGuardScope {
  /** As resolved for the session; refusal messages name it. */
  companionPath: string;
  /**
   * Working Repository root; relative targets resolve against it. Empty for a
   * companion-scoped launch: no Git or product-documentation exemptions apply.
   */
  repositoryPath: string;
  /** Relative-target base without a Working Repository. Defaults to `process.cwd()`. */
  workingDirectory?: string;
  /** Folders holding the Agent Runtime's own state; writes there are never artifacts. */
  runtimeStateRoots: readonly string[];
  /** Whether a Mate launch configured the session; only the fork check reads it. */
  launch: boolean;
}

/**
 * `unreadable`: the call cannot be read well enough for any check to vouch
 * for it (a shell command nested deeper than {@link MAX_SHELL_NESTING}).
 */
export type ToolGuardCheck = "unreadable" | "secret" | "attribution" | "artifact" | "fork";

export interface ToolGuardRefusal {
  check: ToolGuardCheck;
  /** The check's message, without a trailing newline. */
  message: string;
}

export type ToolGuardDeps = SecretGuardDeps;

/** Lower-case: classification ignores letter case, see {@link artifactLikePath}. */
const KNOWN_ARTIFACT_BASENAMES = new Set([
  "claude.md",
  "context.md",
  "design.md",
  "explore-brief.md",
  "proposal.md",
  "spec.md",
  "tasks.md",
]);

const ARTIFACT_PATH_MARKERS = [
  "/changes/",
  "/openspec/",
  "/specs/",
  "/docs/adr/",
  "/docs/adrs/",
  "/docs/decisions/",
  "/docs/prd/",
];

/** Case-insensitive, like secret-file matching: macOS and Windows treat `notes.md` and `NOTES.MD` as one file. */
function artifactLikePath(filePath: string): boolean {
  if (!filePath) return false;

  const lower = filePath.toLowerCase();
  const basename = path.basename(lower);
  const normalized = "/" + lower.replaceAll("\\", "/").replace(/^\/+/, "");
  if (KNOWN_ARTIFACT_BASENAMES.has(basename)) return true;
  if (ARTIFACT_PATH_MARKERS.some((marker) => normalized.includes(marker))) return true;
  return basename.endsWith(".md") && basename !== "readme.md";
}

const SHELL_TOO_DEEP = [
  `Mate guardrail: this shell command nests substitutions more than ${MAX_SHELL_NESTING} levels deep, too deep to check, so it is blocked.`,
  "Split it into smaller commands.",
].join("\n");

function shellArtifactTargets(command: string): string[] {
  return writeTargets(readShell(command)).filter((target) => target.toLowerCase().endsWith(".md"));
}

/** Per call; each part is computed on first use. */
interface GuardContext {
  scope: ToolGuardScope;
  /**
   * The companion as messages name it and as the fork check reads it: the
   * configured path normalised, unless a link before a `..` makes that
   * spelling reach another folder; then where the configured path lands.
   */
  companion: () => string;
  /** Followed through every link, so filesystem identity decides the verdict. */
  companionReal: () => string;
  /**
   * The Projection Root's companion link, its folder followed through every
   * link and its own name kept; empty without a Working Repository.
   */
  companionLink: () => string;
  repoRoot: string;
  base: string;
  /** The Working Repository followed through every link. */
  repoReal: () => string;
}

function once<T>(compute: () => T): () => T {
  let value: { result: T } | undefined;
  return () => (value ??= { result: compute() }).result;
}

function guardContext(scope: ToolGuardScope): GuardContext {
  const ctx: GuardContext = {
    scope,
    companion: once(() => {
      const normalised = path.normalize(scope.companionPath);
      return physicalPath(normalised) === ctx.companionReal() ? normalised : ctx.companionReal();
    }),
    // Configured paths, too, are followed as written, never normalised first.
    companionReal: once(() => physicalPath(scope.companionPath)),
    companionLink: once(() => {
      if (!scope.repositoryPath) return "";
      const link = companionLinkPath(ctx.repoReal());
      return path.join(physicalPath(path.dirname(link)), path.basename(link));
    }),
    repoRoot: scope.repositoryPath,
    base: scope.repositoryPath || scope.workingDirectory || process.cwd(),
    repoReal: once(() => physicalPath(scope.repositoryPath)),
  };
  return ctx;
}

/**
 * Where a write to `target`, as written and relative to `base`, lands; see
 * {@link physicalPath}. Adapters use it to tell whether two spellings name one file.
 */
export function landingPath(target: string, base: string): string {
  return physicalPath(absoluteAsWritten(target, base));
}

/** A tool input's content field: anything but a string carries no content. */
export function contentText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A tool input's path or command field: a malformed value is still judged, as `String()` spells it. */
export function pathText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

export function singleWrite(filePath: unknown, content: string, mode: WriteMode): GuardedToolCall {
  return { kind: "write", writes: [{ path: pathText(filePath), content, mode }] };
}

/** A path of the call, resolved once for every check. */
interface ResolvedPath {
  /** As the agent wrote it. */
  path: string;
  /** Normalised against the Working Repository, as refusal messages show it. */
  lexical: string;
  /** Where the path lands; every filesystem decision reads this one. */
  physical: string;
}

interface ResolvedTarget extends ResolvedPath {
  mode: WriteMode;
}

function resolvePath(value: string, ctx: GuardContext): ResolvedPath {
  return {
    path: value,
    lexical: resolveArtifactTarget(value, ctx.base),
    physical: landingPath(value, ctx.base),
  };
}

function resolveTarget(
  entry: { path: string; mode: WriteMode },
  ctx: GuardContext,
): ResolvedTarget {
  return { ...resolvePath(entry.path, ctx), mode: entry.mode };
}

/**
 * Under the Projection Root's companion link, or under the companion it lands
 * in — the second answers for a link the operator made, and for the first once
 * its target exists. Never a match on path characters alone. `physical` is a
 * {@link physicalPath} result.
 */
function isCompanionPath(physical: string, ctx: GuardContext): boolean {
  const link = ctx.companionLink();
  return (link !== "" && isWithin(physical, link)) || isWithin(physical, ctx.companionReal());
}

/**
 * Every inherited `GIT_*` variable dropped, not only the repository-locating
 * ones `gitEnvironment` clears: `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n` could
 * otherwise add an excludes file that makes a new note look ignored. These two
 * queries are local and read-only, so they need no SSH or credential variable.
 */
function guardGitEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
  );
}

function gitAnswers(ctx: GuardContext, physical: string, args: string[]): boolean {
  if (!ctx.repoRoot || !isWithin(physical, ctx.repoReal())) return false;
  const relPath = path.relative(ctx.repoReal(), physical);
  const result = spawnSync("git", ["-C", ctx.repoRoot, ...args, "--", relPath], {
    stdio: "ignore",
    env: guardGitEnvironment(),
  });
  return result.status === 0;
}

const isGitignored = (physical: string, ctx: GuardContext) =>
  gitAnswers(ctx, physical, ["check-ignore", "--no-index", "-q"]);

/**
 * A file the Working Repository tracks is product material, not a new agent
 * artifact. Literal, so a new `*.md` is not covered by a tracked `notes.md`
 * (`check-ignore` reads its path literally already).
 */
const isGitTracked = (physical: string, ctx: GuardContext) =>
  gitAnswers(ctx, physical, ["--literal-pathspecs", "ls-files", "--error-unmatch"]);

function isProductDocumentationPath(physical: string, ctx: GuardContext): boolean {
  if (!ctx.repoRoot) return false;
  const root = ctx.repoReal();
  if (!isWithin(physical, root)) return false;

  const parts = path.relative(root, physical).split(path.sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    if (part === ".storybook" || part === "storybook") return true;
    if (part !== "docs") continue;
    const docsRoot = path.join(root, ...parts.slice(0, index + 1));
    if (fs.existsSync(path.join(docsRoot, "package.json"))) return true;
  }
  return false;
}

/**
 * Inside a state root where the write lands, or, written without `..`, as
 * written: a user's link in their runtime folder (e.g. into dotfiles) stays
 * state, unless it lands in the Working Repository.
 */
function isRuntimeState(target: ResolvedTarget, ctx: GuardContext): boolean {
  const asWritten =
    !target.path.split(PATH_SEPARATORS).includes("..") &&
    !(ctx.repoRoot && isWithin(target.physical, ctx.repoReal()));
  return ctx.scope.runtimeStateRoots.some(
    (root) =>
      isWithin(target.physical, physicalPath(root)) ||
      // A root configured with `..` has no as-written spelling to compare against.
      (asWritten &&
        !root.split(PATH_SEPARATORS).includes("..") &&
        isWrittenUnder(target.lexical, root)),
  );
}

/**
 * Whether `lexical` lies under `root` as written. A differently cased prefix
 * counts if it is the root's own folder (same device and inode); comparing
 * folders, not resolved paths, leaves links inside the root unfollowed.
 */
function isWrittenUnder(lexical: string, root: string): boolean {
  if (isWithin(lexical, root)) return true;
  const rootPath = path.resolve(root);
  const depth = rootPath.split(path.sep).length;
  const parts = path.resolve(lexical).split(path.sep);
  if (parts.length < depth) return false;
  const prefix = parts.slice(0, depth).join(path.sep);
  return foldCase(prefix) === foldCase(rootPath) && isSameFolder(prefix, rootPath);
}

function isSameFolder(a: string, b: string): boolean {
  try {
    const [first, second] = [fs.statSync(a), fs.statSync(b)];
    return first.isDirectory() && first.dev === second.dev && first.ino === second.ino;
  } catch {
    return false;
  }
}

function isExistingFile(physical: string): boolean {
  try {
    return fs.statSync(physical).isFile();
  } catch {
    return false;
  }
}

function artifactRefusalFor(target: ResolvedTarget, ctx: GuardContext): ToolGuardRefusal | null {
  if (!target.path) return null;

  const { physical } = target;
  if (isCompanionPath(physical, ctx)) return null;
  if (isRuntimeState(target, ctx)) return null;
  if (target.mode === "edit" && isExistingFile(physical)) return null;
  if (isProductDocumentationPath(physical, ctx)) return null;
  if (!artifactLikePath(target.path)) return null;
  if (isGitignored(physical, ctx) || isGitTracked(physical, ctx)) return null;

  // The normalised path, unless a link before a `..` makes it name another file.
  const shown = physicalPath(target.lexical) === physical ? target.lexical : physical;
  return {
    check: "artifact",
    message: artifactRefusal({
      target: target.path,
      resolved: shown,
      companion: ctx.companion(),
      repoRoot: ctx.repoRoot,
    }),
  };
}

/** Depends on companion Git state, not just tool input; `companionForkRefusal` steps aside for a launch. */
async function forkRefusalFor(
  target: ResolvedTarget,
  ctx: GuardContext,
): Promise<ToolGuardRefusal | null> {
  if (!target.path || !artifactLikePath(target.path)) return null;
  if (!isCompanionPath(target.physical, ctx)) return null;
  const message = await companionForkRefusal(ctx.scope.launch, ctx.companion());
  return message ? { check: "fork", message } : null;
}

/** Whether anything, a dangling link included, sits at `filePath`. */
function pathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function secretTarget(resolved: ResolvedPath, ctx: GuardContext): SecretTarget {
  if (!resolved.path) return { path: "", landing: "", exists: false };
  return {
    path: resolved.lexical,
    landing: resolved.physical,
    exists: pathExists(absoluteAsWritten(resolved.path, ctx.base)),
  };
}

/**
 * The call as the secret check reads it; `writes` are the call's writes as the
 * artifact check resolved them, in order. A write is
 * a companion write by its landing or by its normalised path; over-scanning is
 * harmless. A moved file's source stays as written: the check reads it from disk.
 */
function secretCall(
  call: GuardedToolCall,
  writes: ResolvedTarget[],
  ctx: GuardContext,
): SecretCheckCall {
  const targets = (paths: string[]) =>
    paths.map((value) => secretTarget(resolvePath(value, ctx), ctx));
  switch (call.kind) {
    case "read":
      return { kind: "read", targets: targets(call.paths) };
    case "search":
      return { kind: "search", targets: targets(call.paths), globs: call.globs };
    case "shell":
      return call;
    case "write":
      return {
        kind: "write",
        writes: call.writes.map((entry, index): SecretWrite => {
          const target = secretTarget(writes[index], ctx);
          return {
            ...target,
            content: entry.content,
            companion:
              target.path !== "" &&
              (isCompanionPath(target.landing, ctx) ||
                isCompanionPath(physicalPath(target.path), ctx)),
            ...(entry.movedFrom === undefined
              ? {}
              : { movedFrom: absoluteAsWritten(entry.movedFrom, ctx.base) }),
          };
        }),
      };
  }
}

function writtenTargets(call: GuardedToolCall): { path: string; mode: WriteMode }[] {
  if (call.kind === "write") return call.writes;
  if (call.kind === "shell") {
    return shellArtifactTargets(call.command).map((target) => ({ path: target, mode: "create" }));
  }
  return [];
}

async function secretOrAttributionRefusal(
  call: GuardedToolCall,
  targets: ResolvedTarget[],
  ctx: GuardContext,
  deps: ToolGuardDeps,
): Promise<ToolGuardRefusal | null> {
  const secret = await checkSecretAccess(
    secretCall(call, targets, ctx),
    ctx.scope.companionPath,
    deps,
  );
  if (secret) return { check: "secret", message: secret };
  if (call.kind !== "shell") return null;
  const attribution = checkCommitAttribution(call.command);
  return attribution ? { check: "attribution", message: attribution } : null;
}

/**
 * The first refusal for `call`, or null when every check allows it. Paths in
 * `call` are as the agent wrote them; relative ones resolve against the
 * Working Repository, never a preceding `cd`.
 */
export async function checkToolCall(
  call: GuardedToolCall,
  scope: ToolGuardScope,
  deps: ToolGuardDeps = {},
): Promise<ToolGuardRefusal | null> {
  if (!scope.companionPath) return null;
  const ctx = guardContext(scope);

  // Every check that reads a shell command reads it here; the artifact check reads it first.
  let targets: ResolvedTarget[];
  let readingRefusal: ToolGuardRefusal | null;
  try {
    targets = writtenTargets(call).map((entry) => resolveTarget(entry, ctx));
    readingRefusal = await secretOrAttributionRefusal(call, targets, ctx, deps);
  } catch (error) {
    if (error instanceof ShellNestingError) return { check: "unreadable", message: SHELL_TOO_DEEP };
    throw error;
  }
  if (readingRefusal) return readingRefusal;

  for (const target of targets) {
    const refusal = artifactRefusalFor(target, ctx);
    if (refusal) return refusal;
  }
  for (const target of targets) {
    // oxlint-disable-next-line no-await-in-loop -- the first refusal wins
    const refusal = await forkRefusalFor(target, ctx);
    if (refusal) return refusal;
  }
  return null;
}

/**
 * The refusal an adapter gives when the guard itself throws: the call is
 * refused, never allowed unchecked. One line, so it reads as one reason.
 */
export function guardFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Mate guardrail could not check this call: ${detail.replaceAll(/\s*\n\s*/g, " ")}`;
}
