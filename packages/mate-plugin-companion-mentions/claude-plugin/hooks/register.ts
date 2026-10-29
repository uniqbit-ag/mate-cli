/**
 * `@mate:<path>` names a file or folder in the mate Companion Repository.
 * `mate claude` hands over the companion ($MATE_ARTIFACT_PATH) and its secret policy
 * ($MATE_POLICY_JSON); a plain `claude` session asks `mate session context` instead.
 * Without a companion and a readable policy, the mod offers no rows and attaches nothing.
 */

import type { EngineInterface, FsEntry, Register } from "claude-code";
import {
  NO_COMPANION,
  PREFIX,
  UPDATE_MATE,
  type ContextFailure,
  type Entry,
  type Query,
  type SecretPolicy,
  type SessionContext,
  baseName,
  folderNote,
  isAbsolute,
  isInside,
  joinPath,
  launcherFolder,
  launcherPath,
  parseContext,
  parseMention,
  parsePolicy,
  queryOf,
  rank,
  relativeInside,
  rowText,
  secretMatch,
  toEntries,
} from "./companion.ts";

/** How long the menu reuses Mate's answer, and a companion's file list is kept. */
const REFRESH_MS = 30_000;
const CONTEXT_TIMEOUT_MS = 5_000;
/** Rows after a bare `@`, under the engine's own. */
const ROWS = 3;
/** Rows after `@mate:`. */
const ROWS_EXPLICIT = 15;
/** Most files the folder walk collects when git cannot list them. */
const WALK_LIMIT = 20_000;
/** Most names a folder mention lists. */
const FOLDER_LIMIT = 200;
const SKIPPED = new Set([".git", "node_modules"]);

type Context = SessionContext | ContextFailure;

let parsed: { json: string | undefined; result: ReturnType<typeof parsePolicy> } | undefined;
let asked: { sessionRoot: string; answer: Context; at: number } | undefined;
let listed: { root: string; policyJson: string; entries: Entry[]; at: number } | undefined;

/** A clock that went back counts as stale. */
function isFresh(at: number, now: number): boolean {
  return now >= at && now - at < REFRESH_MS;
}

/** `path`'s real location, links followed, or undefined when nothing is there. */
async function realPath($: EngineInterface, path: string) {
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined);
  return stat === undefined ? undefined : { kind: stat.kind, path: stat.realPath ?? path };
}

async function realFolder($: EngineInterface, path: string): Promise<string | undefined> {
  if (!isAbsolute(path)) return undefined;
  const found = await realPath($, path);
  return found?.kind === "dir" ? found.path : undefined;
}

/**
 * A launch is authoritative: a path that names no folder or a missing policy
 * is a failure, never a reason to ask Mate.
 */
async function launchContext($: EngineInterface): Promise<Context | undefined> {
  const path = await $.env.get("MATE_ARTIFACT_PATH");
  if (path === undefined) return undefined;
  const root = await realFolder($, path);
  if (root === undefined) return { reason: NO_COMPANION };
  const json = await $.env.get("MATE_POLICY_JSON");
  if (parsed === undefined || parsed.json !== json) parsed = { json, result: parsePolicy(json) };
  const { result } = parsed;
  if ("error" in result) return { reason: `${result.error}, ${UPDATE_MATE}` };
  return { root, policyJson: json!, policy: result.policy };
}

function errorText(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/** Runs from the launcher's folder, never the session's (see `launcherFolder`). */
async function askMate($: EngineInterface, sessionRoot: string): Promise<Context> {
  const home = (await $.env.get("HOME")) ?? (await $.env.get("USERPROFILE"));
  if (!home) return { reason: `no home folder is set to find mate's launcher in, ${UPDATE_MATE}` };
  if (!isAbsolute(sessionRoot)) {
    return {
      reason: `the session folder ${sessionRoot} is not an absolute path to ask mate about`,
    };
  }
  const launcher = launcherPath(home);
  let stdout: string;
  let exitCode: number;
  try {
    ({ stdout, exitCode } = await $.process.run(
      [launcher, "session", "context", "--repo", sessionRoot, "--json"],
      { cwd: launcherFolder(home), timeoutMs: CONTEXT_TIMEOUT_MS },
    ));
  } catch (error) {
    const message = errorText(error);
    return {
      reason: /tim(?:e|ed)[ -]?out|ETIMEDOUT/i.test(message)
        ? `\`mate session context\` did not answer within ${CONTEXT_TIMEOUT_MS / 1000} seconds, so mate's secret policy is unknown. \`mate doctor\` checks the installation`
        : `mate's launcher ${launcher} could not run (${message}), ${UPDATE_MATE}`,
    };
  }
  const answer = parseContext(stdout);
  if ("reason" in answer) return answer;
  /** Mate exits 0 on every answer it stands by; a failure after printing one voids it. */
  if (exitCode !== 0) {
    return {
      reason: `\`mate session context\` named a companion but exited with status ${exitCode}, so its answer is not used. \`mate doctor\` checks the installation`,
    };
  }
  const root = await realFolder($, answer.root);
  return root === undefined ? { reason: NO_COMPANION } : { ...answer, root };
}

/**
 * Reuses Mate's answer for REFRESH_MS, failures included, so a slow or missing
 * Mate costs one wait per window, not per keystroke.
 */
async function menuContext($: EngineInterface, signal: AbortSignal): Promise<Context> {
  const launch = await launchContext($);
  if (launch !== undefined) return launch;
  const sessionRoot = await $.session.root();
  const now = await $.clock.now();
  if (asked?.sessionRoot === sessionRoot && isFresh(asked.at, now)) return asked.answer;
  const answer = await askMate($, sessionRoot);
  signal.throwIfAborted();
  asked = { sessionRoot, answer, at: now };
  return answer;
}

/** A sent mention asks Mate afresh, never reusing the menu's answer. */
async function mentionContext($: EngineInterface): Promise<Context> {
  return (await launchContext($)) ?? askMate($, await $.session.root());
}

/** Links count as files, as in git. */
async function walk($: EngineInterface, root: string, signal: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  const folders = [""];
  for (let i = 0; i < folders.length && files.length < WALK_LIMIT; i++) {
    const rel = folders[i]!;
    // oxlint-disable-next-line no-await-in-loop -- breadth first: each folder's children decide what to list next.
    const children = await $.fs.list(joinPath(root, rel)).catch(() => []);
    signal.throwIfAborted();
    for (const child of children) {
      if (SKIPPED.has(child.name)) continue;
      if (child.kind === "dir") folders.push(`${rel}${child.name}/`);
      else if (child.kind === "file" || child.isLink) files.push(rel + child.name);
    }
  }
  return files;
}

/**
 * The companion's files, from git so gitignored files stay out (deleted ones
 * too), else from a folder walk. git lists nothing for a companion that is no
 * repository of its own inside one that ignores it, so an empty list is walked
 * too. Throws when the dispatch was abandoned, so a cut-short list is never kept.
 */
async function listFiles($: EngineInterface, root: string, signal: AbortSignal): Promise<string[]> {
  try {
    const run = (args: string[]) =>
      $.process.run(["git", "ls-files", "-z", ...args], { cwd: root, timeoutMs: 10_000 });
    const [present, deleted] = await Promise.all([
      run(["--cached", "--others", "--exclude-standard"]),
      run(["--deleted"]),
    ]);
    if (present.exitCode === 0) {
      const files = present.stdout.split("\0");
      if (present.isStdoutTruncated) files.pop(); // cut mid-path
      const gone = new Set(deleted.exitCode === 0 ? deleted.stdout.split("\0") : []);
      const paths = files.filter((file) => file !== "" && !gone.has(file));
      if (paths.length > 0) return paths;
    }
  } catch {
    signal.throwIfAborted();
    /** git could not run (not installed, timed out): walk below. */
  }
  return walk($, root, signal);
}

/** The companion's rows to rank, kept for REFRESH_MS per companion and policy. */
async function entriesOf(
  $: EngineInterface,
  context: SessionContext,
  signal: AbortSignal,
): Promise<readonly Entry[]> {
  const { root, policyJson } = context;
  const now = await $.clock.now();
  if (listed?.root === root && listed.policyJson === policyJson && isFresh(listed.at, now)) {
    return listed.entries;
  }
  const entries = toEntries(await listFiles($, root, signal), context.policy);
  listed = { root, policyJson, entries, at: now };
  return entries;
}

/**
 * Whether the menu may offer an entry, as a mention would attach it: it is
 * still a file or folder, it leads to no place outside the companion, and a
 * file's real location is no secret file. The listed path was checked already.
 */
async function isOfferable(
  $: EngineInterface,
  root: string,
  policy: SecretPolicy,
  entry: Entry,
): Promise<boolean> {
  const target = await $.fs
    .stat(joinPath(root, entry.rel), { resolve: true })
    .catch(() => undefined);
  if (target?.realPath === undefined) return false;
  const realRel = relativeInside(target.realPath, root);
  if (realRel === undefined) return false;
  if (target.kind === "dir") return true;
  return target.kind === "file" && secretMatch(policy, realRel) === undefined;
}

/** The first `limit` of the ranked entries the menu may offer, checked a batch at a time. */
async function offerable(
  $: EngineInterface,
  root: string,
  policy: SecretPolicy,
  ranked: readonly Entry[],
  limit: number,
  signal: AbortSignal,
): Promise<Entry[]> {
  const kept: Entry[] = [];
  for (let at = 0; at < ranked.length && kept.length < limit; at += limit) {
    const batch = ranked.slice(at, at + limit);
    // oxlint-disable-next-line no-await-in-loop -- the next batch is checked only when this one left room.
    const isKept = await Promise.all(batch.map((entry) => isOfferable($, root, policy, entry)));
    signal.throwIfAborted();
    kept.push(...batch.filter((_, i) => isKept[i]));
  }
  return kept.slice(0, limit);
}

async function companionRows($: EngineInterface, query: Query, signal: AbortSignal) {
  const context = await menuContext($, signal);
  if ("reason" in context) return [];
  const { root, policy } = context;
  const sessionRoot = await $.session.root();
  const session = (await realPath($, sessionRoot))?.path ?? sessionRoot;
  if (isInside(session, root)) return [];

  const entries = await entriesOf($, context, signal);
  const ranked = rank(entries, query, entries.length);
  const limit = query.isExplicit ? ROWS_EXPLICIT : ROWS;
  const offered = await offerable($, root, policy, ranked, limit, signal);
  const description = `${baseName(root)} (mate companion)`;
  const rows = offered.flatMap((entry) => {
    const text = rowText(entry);
    return text === undefined ? [] : [{ text, label: PREFIX + entry.rel, description }];
  });
  if (!query.isExplicit && PREFIX.startsWith(query.query.toLowerCase())) {
    rows.unshift({ text: `@${PREFIX}`, label: PREFIX, description });
  }
  return rows;
}

function under(rel: string, name: string): string {
  return rel === "" ? name : `${rel}/${name}`;
}

/** What a mention attaches instead of a file: a note for Claude. */
function note(text: string) {
  return { type: null, context: [text] };
}

export const register: Register = (on) => {
  on("prompt.autocomplete", { token: /^@/ }, async ($, e, next) => {
    const result = await next(e);
    const query = queryOf(e.token);
    if (query === undefined) return result;
    const rows = await companionRows($, query, next.signal).catch((error: unknown) => {
      if (next.signal.aborted) return []; // a newer keystroke took over
      throw error;
    });
    return rows.length === 0
      ? result
      : { ...result, suggestions: [...result.suggestions, ...rows] };
  });

  on("prompt.mention", { mention: /^mate:/i }, async ($, e, next) => {
    const named = parseMention(e.mention);
    if (named === undefined) return next(e);
    if ("refused" in named) return note(`@${e.mention} was not attached: ${named.refused}.`);

    const context = await mentionContext($);
    if ("reason" in context) return note(`@${e.mention} was not attached: ${context.reason}.`);
    const { root, policy } = context;

    const shown = `@${PREFIX}${named.rel}`;
    const path = joinPath(root, named.rel);
    const target = await $.fs.stat(path, { resolve: true }).catch(() => undefined);
    if (target === undefined) {
      return note(`${shown} was not found in the mate companion repo (${root}).`);
    }
    if (target.realPath === undefined) {
      return note(`${shown} was not attached: ${path} is a link that leads nowhere.`);
    }
    const realRel = relativeInside(target.realPath, root);
    if (realRel === undefined) {
      return note(
        `${shown} was not attached: ${path} is a link to ${target.realPath}, outside the mate companion repo.`,
      );
    }
    /** Both the path named and where it leads count; folders above the companion never match. */
    const secretOf = (namedRel: string, landedRel: string) =>
      secretMatch(policy, namedRel) ?? secretMatch(policy, landedRel);
    if (target.kind === "dir") {
      /** List where the checks looked: a link repointed since would list another folder. */
      const landedFolder = target.realPath;
      const children = await $.fs.list(landedFolder);
      /** A linked entry is judged where it leads, as a mention of it would be. */
      const judged = await Promise.all(
        children.map(async (child: FsEntry) => {
          if (child.name === ".git") return undefined;
          const namedRel = under(named.rel, child.name);
          if (!child.isLink) {
            if (child.kind === "dir") return { name: child.name, isDir: true };
            const isSecret = secretOf(namedRel, under(realRel, child.name)) !== undefined;
            return isSecret ? undefined : { name: child.name, isDir: false };
          }
          const landed = await $.fs
            .stat(joinPath(landedFolder, child.name), { resolve: true })
            .catch(() => undefined);
          const landedRel =
            landed?.realPath === undefined ? undefined : relativeInside(landed.realPath, root);
          if (landed === undefined || landedRel === undefined) return undefined;
          if (landed.kind === "dir") return { name: child.name, isDir: true };
          return secretOf(namedRel, landedRel) === undefined
            ? { name: child.name, isDir: false }
            : undefined;
        }),
      );
      const shownChildren = judged.filter((child) => child !== undefined);
      return note(folderNote(shown, path, shownChildren, FOLDER_LIMIT));
    }
    if (target.kind !== "file") {
      return note(`${shown} was not attached: ${path} is not a file or folder.`);
    }
    const secret = secretOf(named.rel, realRel);
    if (secret !== undefined) {
      return note(
        `${shown} was not attached: mate keeps secret files (\`${secret}\`) away from Claude.`,
      );
    }

    /** Read where the checks looked, not through the link, which could change. */
    const read = await next({ ...e, path: target.realPath });
    if (read.deny !== undefined) return read;
    return {
      ...read,
      context: [
        ...(read.context ?? []),
        `${shown} is the file ${target.realPath} in the mate companion repo.`,
      ],
    };
  }).catch(($, e, next) =>
    next.called
      ? next(e)
      : note(
          `@${e.mention} was not attached: looking it up in the mate companion repo failed (${next.error.message ?? next.error.kind}).`,
        ),
  );
};
