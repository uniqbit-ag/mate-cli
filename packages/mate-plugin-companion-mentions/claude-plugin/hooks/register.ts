// mate companion mentions: `@mate:<path>` names a file or folder in the mate
// Companion Repository, from any Working Repository, on every OS.
//
// - prompt.autocomplete adds `mate:` rows under the built-in `@` rows, except
//   in a session inside the companion, whose files Claude already lists.
// - prompt.mention reads `@mate:<path>` from the companion repo, so the file
//   is attached like any other mention; what it cannot attach, it explains
//   to Claude instead.
//
// `mate claude` hands over the companion in $MATE_ARTIFACT_PATH and its secret
// policy in $MATE_POLICY_JSON. Without a readable policy the mod offers no
// rows and attaches nothing.

import type { EngineInterface, FsEntry, Register } from "claude-code";
import {
  PREFIX,
  type Entry,
  type Query,
  type SecretPolicy,
  baseName,
  folderNote,
  isAbsolute,
  isInside,
  joinPath,
  parseMention,
  parsePolicy,
  queryOf,
  rank,
  relativeInside,
  rowText,
  secretMatch,
  toEntries,
} from "./companion.ts";

/** How long a companion's file list is kept. */
const REFRESH_MS = 30_000;
/** Rows after a bare `@`, under the engine's own. */
const ROWS = 3;
/** Rows after `@mate:`. */
const ROWS_EXPLICIT = 15;
/** Most files the folder walk collects when git cannot list them. */
const WALK_LIMIT = 20_000;
/** Most names a folder mention lists. */
const FOLDER_LIMIT = 200;
const SKIPPED = new Set([".git", "node_modules"]);

let parsed: { json: string | undefined; result: ReturnType<typeof parsePolicy> } | undefined;
let listed: { root: string; policy: SecretPolicy; entries: Entry[]; at: number } | undefined;

/** Whether something kept at `at` may still be used at `now`; a clock that went back counts as stale. */
function isFresh(at: number, now: number): boolean {
  return now >= at && now - at < REFRESH_MS;
}

/** `path`'s real location, links followed, or undefined when nothing is there. */
async function realPath($: EngineInterface, path: string) {
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined);
  return stat === undefined ? undefined : { kind: stat.kind, path: stat.realPath ?? path };
}

/** The companion's real path from $MATE_ARTIFACT_PATH, or undefined when it names no folder. */
async function companionRoot($: EngineInterface): Promise<string | undefined> {
  const path = await $.env.get("MATE_ARTIFACT_PATH");
  if (!path || !isAbsolute(path)) return undefined;
  const found = await realPath($, path);
  return found?.kind === "dir" ? found.path : undefined;
}

/** The secret policy from $MATE_POLICY_JSON, parsed once per value. */
async function secretPolicy($: EngineInterface): Promise<ReturnType<typeof parsePolicy>> {
  const json = await $.env.get("MATE_POLICY_JSON");
  if (parsed === undefined || parsed.json !== json) parsed = { json, result: parsePolicy(json) };
  return parsed.result;
}

/** Every file below `root`, breadth first, skipping `.git` and `node_modules`; links count as files, as in git. */
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
    // git could not run (not installed, timed out): walk below.
  }
  return walk($, root, signal);
}

/** The companion's rows to rank, kept for REFRESH_MS per companion and policy. */
async function entriesOf(
  $: EngineInterface,
  root: string,
  policy: SecretPolicy,
  signal: AbortSignal,
): Promise<readonly Entry[]> {
  const now = await $.clock.now();
  if (listed?.root === root && listed.policy === policy && isFresh(listed.at, now)) {
    return listed.entries;
  }
  const entries = toEntries(await listFiles($, root, signal), policy);
  listed = { root, policy, entries, at: now };
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

/**
 * The rows to add under the engine's for `query`: none without a companion
 * or a readable policy, and none in a session inside the companion.
 */
async function companionRows($: EngineInterface, query: Query, signal: AbortSignal) {
  const root = await companionRoot($);
  if (root === undefined) return [];
  const sessionRoot = await $.session.root();
  const session = (await realPath($, sessionRoot))?.path ?? sessionRoot;
  if (isInside(session, root)) return [];
  const secrets = await secretPolicy($);
  if ("error" in secrets) return [];

  const entries = await entriesOf($, root, secrets.policy, signal);
  const ranked = rank(entries, query, entries.length);
  const limit = query.isExplicit ? ROWS_EXPLICIT : ROWS;
  const offered = await offerable($, root, secrets.policy, ranked, limit, signal);
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

/** `name` in the companion folder `rel` (`''` for the companion's top). */
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

    const root = await companionRoot($);
    if (root === undefined) {
      return note(
        `@${e.mention} was not attached: this session has no mate companion. Sessions started with \`mate claude\` have one.`,
      );
    }
    const secrets = await secretPolicy($);
    if ("error" in secrets) {
      return note(
        `@${e.mention} was not attached: ${secrets.error}, so mate's secret policy is unknown. A mate version that matches the mate-companion-mentions plugin fixes this.`,
      );
    }

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
    // Both the path named and where it leads count, but only inside the
    // companion: folders above it never match a secret pattern.
    const secretOf = (namedRel: string, landedRel: string) =>
      secretMatch(secrets.policy, namedRel) ?? secretMatch(secrets.policy, landedRel);
    if (target.kind === "dir") {
      const children = await $.fs.list(path);
      const isListed = (child: FsEntry) =>
        child.name !== ".git" &&
        (child.kind === "dir" ||
          secretOf(under(named.rel, child.name), under(realRel, child.name)) === undefined);
      const shownChildren = children
        .filter(isListed)
        .map((child) => ({ name: child.name, isDir: child.kind === "dir" }));
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

    // Read where the checks looked, not through the link, which could change.
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
