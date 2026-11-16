/**
 * Image lock drift: the global-tools lock of each image pins the published
 * release packages, but their dependency metadata follows the working tree.
 * `checkImageLocks` finds that drift read-only. `refreshImageLocks` repairs it
 * before publication without moving a pin that the dependency change does not
 * explain.
 *
 * Node built-ins only.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RELEASE_PACKAGES } from "../../apps/mate-container/src/image-pins";

/** Workspace-relative image roots whose global-tools locks are checked independently. */
const IMAGE_ROOTS = ["apps/mate-container", "apps/mate-factory"] as const;

const MANIFEST = "locks/global-tools.package.json";
const LOCK = "locks/global-tools.package-lock.json";

export const REFRESH_COMMAND = "bun scripts/image-locks/cli.ts refresh";

const DECLARATION_FIELDS = [
  "dependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "optionalDependencies",
] as const;
type DeclarationField = (typeof DECLARATION_FIELDS)[number];
type Declarations = Partial<Record<DeclarationField, Record<string, unknown>>>;

type LockEntry = Declarations & { version?: string; resolved?: string; integrity?: string };
type Lock = { packages?: Record<string, LockEntry> };
type Manifest = { dependencies?: Record<string, string> };
type ReleaseMetadata = Declarations & { name: string };

export type NpmResult = { status: number | null; stdout: string; stderr: string };
export type NpmRunner = (args: readonly string[], options: { cwd: string }) => NpmResult;
export type Formatter = (source: string, lockPath: string) => string;

export type Deps = {
  runNpm: NpmRunner;
  /** Formats a lock the way the repository commits it, so a refresh adds no formatting churn. */
  format: Formatter;
  writeFile: (file: string, contents: string) => void;
  rename: (from: string, to: string) => void;
};

export type LockCheck = { lock: string; problems: string[] };

export type PinChange =
  | { kind: "added"; path: string; version: string }
  | { kind: "removed"; path: string; version: string }
  | { kind: "changed"; path: string; from: string; to: string };

export type LockRefresh = { lock: string; changes: PinChange[]; changed: boolean };

/** A failure the maintainer can act on, as opposed to a bug in this tool. */
export class LockDriftError extends Error {}

function npmEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
}

export const spawnNpm: NpmRunner = (args, { cwd }) => {
  const result = spawnSync("npm", args, {
    cwd,
    env: npmEnvironment(),
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  if (result.error) throw new LockDriftError(`could not run npm: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

/** Formats through the workspace's oxfmt, which the format check also uses. */
function oxfmtFormatter(workspaceRoot: string): Formatter {
  return (source, lockPath) => {
    const result = spawnSync(
      path.join(workspaceRoot, "node_modules", ".bin", "oxfmt"),
      ["--stdin-filepath", lockPath],
      { cwd: workspaceRoot, input: source, encoding: "utf8", maxBuffer: 1 << 28 },
    );
    if (result.error || result.status !== 0) {
      throw new LockDriftError(
        `could not format the candidate lock with oxfmt (run \`bun install\` first): ${result.error?.message ?? result.stderr.trim()}`,
      );
    }
    return result.stdout;
  };
}

export function defaultDeps(workspaceRoot: string): Deps {
  return {
    runNpm: spawnNpm,
    format: oxfmtFormatter(workspaceRoot),
    writeFile: (file, contents) => fs.writeFileSync(file, contents),
    rename: (from, to) => fs.renameSync(from, to),
  };
}

/** A package that tracks the Mate release version, so its range follows publication. */
function isMatePackage(name: string): boolean {
  return name === "@uniqbit/mate" || name.startsWith("@uniqbit/mate-");
}

function lockPathOf(imageRoot: string): string {
  return `${imageRoot}/${LOCK}`;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function readReleaseMetadata(workspaceRoot: string): ReleaseMetadata[] {
  return RELEASE_PACKAGES.map(({ dir }) =>
    readJson<ReleaseMetadata>(path.join(workspaceRoot, dir, "package.json")),
  );
}

function releaseKey(name: string): string {
  return `node_modules/${name}`;
}

/** The release range of a Mate package is owned by publication, so only its presence counts. */
function comparable(field: DeclarationField, name: string, value: unknown): string {
  return field !== "peerDependenciesMeta" && isMatePackage(name)
    ? "<release>"
    : JSON.stringify(value);
}

/** Names whose declared range differs between two sets of declarations. */
function declarationChanges(
  before: Declarations,
  after: Declarations,
): { field: DeclarationField; name: string; before?: unknown; after?: unknown }[] {
  const changes: { field: DeclarationField; name: string; before?: unknown; after?: unknown }[] =
    [];
  for (const field of DECLARATION_FIELDS) {
    const previous = before[field] ?? {};
    const next = after[field] ?? {};
    for (const name of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      const had = name in previous;
      const has = name in next;
      if (
        had &&
        has &&
        comparable(field, name, previous[name]) === comparable(field, name, next[name])
      )
        continue;
      changes.push({ field, name, before: previous[name], after: next[name] });
    }
  }
  return changes;
}

function describeRange(field: DeclarationField, value: unknown): string {
  return field === "peerDependenciesMeta" ? JSON.stringify(value) : String(value);
}

/** Release-package metadata and root manifest drift: what a lock records versus the tree. */
function metadataProblems(
  lock: Lock,
  manifest: Manifest,
  releases: readonly ReleaseMetadata[],
): string[] {
  const problems: string[] = [];
  const entries = lock.packages ?? {};

  for (const release of releases) {
    const entry = entries[releaseKey(release.name)];
    if (!entry) {
      problems.push(`${release.name} has no entry in the lock`);
      continue;
    }
    for (const change of declarationChanges(entry, release)) {
      const lockHas = change.before !== undefined;
      const treeHas = change.after !== undefined;
      const subject = `${release.name} ${change.field}`;
      if (!lockHas) {
        problems.push(
          `${subject}: the lock lacks "${change.name}@${describeRange(change.field, change.after)}"`,
        );
      } else if (!treeHas) {
        problems.push(
          `${subject}: the lock still has "${change.name}@${describeRange(change.field, change.before)}", which the release package dropped`,
        );
      } else {
        problems.push(
          `${subject}: "${change.name}" is ${describeRange(change.field, change.before)} in the lock but ${describeRange(change.field, change.after)} in the release package`,
        );
      }
    }
  }

  const rootDependencies = entries[""]?.dependencies ?? {};
  const manifestDependencies = manifest.dependencies ?? {};
  for (const name of new Set([
    ...Object.keys(rootDependencies),
    ...Object.keys(manifestDependencies),
  ])) {
    const inLock = rootDependencies[name];
    const inManifest = manifestDependencies[name];
    if (inManifest === undefined) {
      problems.push(`the lock root still requires "${name}", which the manifest no longer does`);
    } else if (inLock === undefined) {
      problems.push(`the lock root is missing "${name}@${inManifest}" from the manifest`);
    } else if (!isMatePackage(name) && inLock !== inManifest) {
      problems.push(
        `the lock root requires "${name}@${inLock}" but the manifest has ${inManifest}`,
      );
    }
  }
  return problems;
}

/**
 * Asks npm to walk the production graph of the committed pins. `--package-lock-only`
 * and `--offline` mean nothing is resolved or fetched, and `ls` runs no scripts.
 */
function graphProblems(
  lockSource: string,
  manifestSource: string,
  { runNpm }: Pick<Deps, "runNpm">,
): string[] {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-lock-graph-")));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), manifestSource);
    fs.writeFileSync(path.join(dir, "package-lock.json"), lockSource);
    const result = runNpm(
      ["ls", "--all", "--package-lock-only", "--omit=dev", "--json", "--offline"],
      { cwd: dir },
    );
    let report: { problems?: string[] };
    try {
      report = JSON.parse(result.stdout) as { problems?: string[] };
    } catch {
      throw new LockDriftError(`npm ls gave no readable report: ${result.stderr.trim()}`);
    }
    return (report.problems ?? []).map((problem) => problem.split(dir).join("."));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function allProblems(
  lockSource: string,
  manifestSource: string,
  releases: readonly ReleaseMetadata[],
  deps: Pick<Deps, "runNpm">,
): string[] {
  const lock = JSON.parse(lockSource) as Lock;
  const manifest = JSON.parse(manifestSource) as Manifest;
  return [
    ...metadataProblems(lock, manifest, releases),
    ...graphProblems(lockSource, manifestSource, deps),
  ];
}

/** Read-only: never writes a tracked file, resolves a version, or runs a lifecycle script. */
export function checkImageLocks(workspaceRoot: string, deps: Pick<Deps, "runNpm">): LockCheck[] {
  const releases = readReleaseMetadata(workspaceRoot);
  return IMAGE_ROOTS.map((imageRoot) => {
    const lockSource = fs.readFileSync(path.join(workspaceRoot, lockPathOf(imageRoot)), "utf8");
    const manifestSource = fs.readFileSync(path.join(workspaceRoot, imageRoot, MANIFEST), "utf8");
    return {
      lock: lockPathOf(imageRoot),
      problems: allProblems(lockSource, manifestSource, releases, deps),
    };
  });
}

type Prepared = {
  lock: string;
  file: string;
  original: string;
  candidate: string;
  changes: PinChange[];
};

const NETWORK_FAILURE =
  /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|FETCH_ERROR|ENETUNREACH/;

/** Copies the lock with each release entry's declarations replaced by the tree's. */
function withReleaseDeclarations(lock: Lock, releases: readonly ReleaseMetadata[]): Lock {
  const next = structuredClone(lock);
  const entries = next.packages ?? {};
  for (const release of releases) {
    const entry = entries[releaseKey(release.name)];
    if (!entry) continue;
    for (const field of DECLARATION_FIELDS) {
      const wanted = release[field];
      if (!wanted || Object.keys(wanted).length === 0) {
        delete entry[field];
        continue;
      }
      const previous = entry[field] ?? {};
      entry[field] = Object.fromEntries(
        Object.entries(wanted)
          .toSorted(([a], [b]) => compareStrings(a, b))
          .map(([name, range]) => {
            if (field === "peerDependenciesMeta" || !isMatePackage(name)) return [name, range];
            return [name, previous[name] ?? entries[releaseKey(name)]?.version ?? range];
          }),
      );
    }
  }
  return next;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pinOf(entry: LockEntry): string {
  return `${entry.version ?? "?"}|${entry.resolved ?? ""}|${entry.integrity ?? ""}`;
}

function packageNameAt(lockPath: string): string {
  return lockPath.slice(lockPath.lastIndexOf("node_modules/") + "node_modules/".length);
}

/** The packages, and everything they install, whose pins a changed declaration may move. */
function dependencyClosure(lock: Lock, roots: ReadonlySet<string>): Set<string> {
  const closure = new Set(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.pop()!;
    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
      if (key === "" || packageNameAt(key) !== name) continue;
      for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
        for (const dependency of Object.keys(entry[field] ?? {})) {
          if (!closure.has(dependency)) {
            closure.add(dependency);
            queue.push(dependency);
          }
        }
      }
    }
  }
  return closure;
}

function pinChanges(before: Lock, after: Lock): PinChange[] {
  const previous = before.packages ?? {};
  const next = after.packages ?? {};
  const changes: PinChange[] = [];
  for (const [key, entry] of Object.entries(next)) {
    if (key === "") continue;
    const old = previous[key];
    if (!old) changes.push({ kind: "added", path: key, version: entry.version ?? "?" });
    else if (pinOf(old) !== pinOf(entry)) {
      changes.push({
        kind: "changed",
        path: key,
        from: old.version ?? "?",
        to: entry.version ?? "?",
      });
    }
  }
  for (const [key, entry] of Object.entries(previous)) {
    if (key !== "" && !next[key]) {
      changes.push({ kind: "removed", path: key, version: entry.version ?? "?" });
    }
  }
  return changes.toSorted((a, b) => compareStrings(a.path, b.path));
}

function prepare(
  workspaceRoot: string,
  imageRoot: string,
  releases: readonly ReleaseMetadata[],
  deps: Deps,
): Prepared {
  const lockName = lockPathOf(imageRoot);
  const file = path.join(workspaceRoot, lockName);
  const original = fs.readFileSync(file, "utf8");
  const manifestSource = fs.readFileSync(path.join(workspaceRoot, imageRoot, MANIFEST), "utf8");
  const lock = JSON.parse(original) as Lock;

  for (const release of releases) {
    if (!lock.packages?.[releaseKey(release.name)]) {
      throw new LockDriftError(
        `${lockName}: ${release.name} has no entry, and refresh does not add release packages`,
      );
    }
  }

  const seeded = withReleaseDeclarations(lock, releases);
  const explained = new Set<string>();
  for (const release of releases) {
    const key = releaseKey(release.name);
    for (const change of declarationChanges(lock.packages![key]!, seeded.packages![key]!)) {
      explained.add(change.name);
    }
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mate-lock-refresh-"));
  let resolved: Lock;
  try {
    fs.writeFileSync(path.join(dir, "package.json"), manifestSource);
    fs.writeFileSync(path.join(dir, "package-lock.json"), `${JSON.stringify(seeded, null, 2)}\n`);
    const result = deps.runNpm(
      ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: dir },
    );
    if (result.status !== 0) {
      const output = result.stderr.trim();
      const reason = NETWORK_FAILURE.test(output)
        ? "the registry could not be reached, so this is not drift"
        : "npm could not resolve the changed dependencies";
      throw new LockDriftError(`${lockName}: ${reason}\n${output}`);
    }
    resolved = JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8")) as Lock;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // The registry pin of a release package belongs to release preparation.
  for (const release of releases) {
    const key = releaseKey(release.name);
    const source = lock.packages![key]!;
    const target = resolved.packages?.[key];
    if (!target) {
      throw new LockDriftError(`${lockName}: the candidate dropped ${release.name}`);
    }
    target.version = source.version;
    target.resolved = source.resolved;
    target.integrity = source.integrity;
  }

  const changes = pinChanges(lock, resolved);
  const allowed = dependencyClosure(resolved, explained);
  const unexplained = changes.filter(
    (change): change is Extract<PinChange, { kind: "changed" }> =>
      change.kind === "changed" && !allowed.has(packageNameAt(change.path)),
  );
  if (unexplained.length > 0) {
    throw new LockDriftError(
      [
        `${lockName}: refreshing needs ${unexplained.length} existing pin(s) changed that the dependency change does not explain; nothing was written:`,
        ...unexplained.map((change) => `  ${change.path} ${change.from} -> ${change.to}`),
        "Update those pins deliberately, then run the refresh again.",
      ].join("\n"),
    );
  }

  const unchanged = changes.length === 0 && JSON.stringify(resolved) === JSON.stringify(lock);
  const candidate = unchanged
    ? original
    : deps.format(`${JSON.stringify(resolved, null, 2)}\n`, lockName);

  const problems = allProblems(candidate, manifestSource, releases, deps);
  if (problems.length > 0) {
    throw new LockDriftError(
      [
        `${lockName}: the candidate is not valid; nothing was written:`,
        ...problems.map((p) => `  ${p}`),
      ].join("\n"),
    );
  }

  return { lock: lockName, file, original, candidate, changes };
}

/**
 * Prepares and validates both candidates before replacing either lock. A
 * failure while writing restores any lock already replaced.
 */
export function refreshImageLocks(workspaceRoot: string, deps: Deps): LockRefresh[] {
  const releases = readReleaseMetadata(workspaceRoot);
  const prepared = IMAGE_ROOTS.map((imageRoot) =>
    prepare(workspaceRoot, imageRoot, releases, deps),
  );
  const pending = prepared.filter(({ candidate, original }) => candidate !== original);

  const temporaries = pending.map(({ file }) => `${file}.refresh-${process.pid}`);
  const replaced: Prepared[] = [];
  try {
    pending.forEach(({ candidate }, index) => deps.writeFile(temporaries[index]!, candidate));
    for (const [index, item] of pending.entries()) {
      deps.rename(temporaries[index]!, item.file);
      replaced.push(item);
    }
  } catch (error) {
    for (const item of replaced) fs.writeFileSync(item.file, item.original);
    throw error;
  } finally {
    for (const temporary of temporaries) fs.rmSync(temporary, { force: true });
  }

  return prepared.map(({ lock, changes, candidate, original }) => ({
    lock,
    changes,
    changed: candidate !== original,
  }));
}
