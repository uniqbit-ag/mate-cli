// A fake machine for the hook tests: a disk with links, git, the session and
// the engine's own mention read. Tests use paths of their own, so none depends
// on what the mod kept from another.

import { mock } from "claude-code/testing";
import type { FsEntry, On, PromptMentionResult } from "claude-code";

/**
 * What a path holds: a file's text, a folder (null), a link to an absolute
 * path, or something neither file nor folder (a socket, say).
 */
export type Node = string | null | { link: string } | { other: true };

/**
 * What `git ls-files` answers in a folder: its files, an exit code, or `throw`
 * when git cannot start. The files listed, gitignored ones too, are on disk
 * unless deleted. `ignored` files are listed only without
 * `--exclude-standard`. `stallsFirst` holds the first listing until the test
 * calls `killGit`, which rejects it as the engine does when it kills the git
 * of an abandoned lookup.
 */
export type Git =
  | {
      files: string[];
      ignored?: string[];
      deleted?: string[];
      isTruncated?: boolean;
      stallsFirst?: boolean;
    }
  | { exitCode: number }
  | "throw";

export type Setup = {
  /** What is on disk, by absolute path; every folder above a path is there too. */
  disk?: Record<string, Node>;
  env?: Record<string, string>;
  /** `$.session.root()`; `/work/app` when absent. */
  sessionRoot?: string;
  /** The main working tree's root, as `$.session.repo()` answers; no repository when absent. */
  repoRoot?: string;
  /** git's answer by the folder it runs in; a folder not listed is no repository. */
  git?: Record<string, Git>;
  /** What the engine's own read of a mention resolves to; a file when absent. */
  mentionResult?: PromptMentionResult;
  /** Folders that are there but cannot be listed. */
  unlistable?: string[];
};

export type Read = { path: string; offset?: number; limit?: number };

function isLink(node: Node | undefined): node is { link: string } {
  return typeof node === "object" && node !== null && "link" in node;
}

function trim(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** How git exits: its code, what it printed, and whether that was cut short. */
function exited(exitCode: number, stdout: string, isStdoutTruncated = false) {
  return {
    value: { exitCode, stdout, stderr: "", isStdoutTruncated, isStderrTruncated: false },
  };
}

export function world(on: On, setup: Setup) {
  const disk: Record<string, Node> = { ...setup.disk };
  for (const [cwd, git] of Object.entries(setup.git ?? {})) {
    if (typeof git !== "object" || !("files" in git)) continue;
    for (const file of [...git.files, ...(git.ignored ?? [])]) {
      if (git.deleted?.includes(file)) continue;
      const path = `${cwd}/${file.replace(/\/$/, "")}`;
      disk[path] ??= file.endsWith("/") ? null : "";
    }
  }
  const reads: Read[] = [];
  const runs: string[][] = [];
  mock.env(on, setup.env ?? {});
  const clock = mock.clock(on);

  /** Where a path lands, every link followed; undefined past ten hops. */
  const landing = (path: string, hops = 0): string | undefined => {
    let at = "";
    for (const part of path.split("/").filter(Boolean)) {
      const node = disk[`${at}/${part}`];
      if (!isLink(node)) {
        at = `${at}/${part}`;
        continue;
      }
      const target = hops < 10 ? landing(node.link, hops + 1) : undefined;
      if (target === undefined) return undefined;
      at = target;
    }
    return at === "" ? "/" : at;
  };
  const kindAt = (path: string): "file" | "dir" | "other" | undefined => {
    const node = disk[path];
    if (typeof node === "string") return "file";
    if (typeof node === "object" && node !== null && "other" in node) return "other";
    if (
      node === null ||
      path === "/" ||
      Object.keys(disk).some((key) => key.startsWith(`${path}/`))
    )
      return "dir";
    return undefined;
  };
  const existing = (path: string) => {
    const landed = landing(trim(path));
    return landed !== undefined && kindAt(landed) !== undefined ? landed : undefined;
  };

  on("fs.stat", ($, e) => {
    const path = trim(e.path);
    const linked = isLink(disk[path]);
    const landed = existing(path);
    if (landed === undefined) {
      return linked
        ? { value: { kind: "other", size: 0, mtimeMs: 0, isLink: true } }
        : { deny: `ENOENT: ${e.path}` };
    }
    const kind = kindAt(landed)!;
    return {
      value: {
        kind,
        size: 0,
        mtimeMs: 0,
        isLink: linked,
        ...(e.resolve ? { realPath: landed } : {}),
      },
    };
  });
  on("fs.exists", ($, e) => ({ value: existing(e.path) !== undefined }));
  on("fs.read", ($, e) => {
    const landed = existing(e.path);
    const node = landed === undefined ? undefined : disk[landed];
    return typeof node === "string" ? { value: node } : { deny: `ENOENT: ${e.path}` };
  });
  on("fs.list", ($, e) => {
    const landed = existing(e.path);
    if (landed === undefined || kindAt(landed) !== "dir") return { deny: `ENOTDIR: ${e.path}` };
    if (setup.unlistable?.includes(landed)) return { deny: `EACCES: ${e.path}` };
    const prefix = landed === "/" ? "/" : `${landed}/`;
    const names = new Set<string>();
    for (const key of Object.keys(disk)) {
      if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0]!);
    }
    const value: FsEntry[] = [...names].map((name) => {
      const node = disk[prefix + name];
      const kind = isLink(node) ? "other" : (kindAt(prefix + name) ?? "dir");
      return { name, kind, size: 0, mtimeMs: 0, isLink: isLink(node) };
    });
    return { value };
  });

  let hasStalled = false;
  let killGit: (() => void) | undefined;
  on("process.run", ($, e) => {
    runs.push([...e.argv]);
    const git = setup.git?.[e.init?.cwd ?? ""] ?? { exitCode: 128 };
    if (git === "throw") return { deny: "spawn git ENOENT" };
    if ("files" in git && git.stallsFirst && !hasStalled && !e.argv.includes("--deleted")) {
      hasStalled = true;
      return new Promise<{ deny: string }>((resolve) => {
        killGit = () => resolve({ deny: "aborted" });
      });
    }
    if ("exitCode" in git) return exited(git.exitCode, "");
    if (e.argv.includes("--deleted"))
      return exited(0, (git.deleted ?? []).map((file) => `${file}\0`).join(""));
    const ignored = e.argv.includes("--exclude-standard") ? [] : (git.ignored ?? []);
    const stdout = [...ignored, ...git.files].map((file) => `${file}\0`).join("");
    return git.isTruncated ? exited(0, stdout.slice(0, -1), true) : exited(0, stdout);
  });

  on("session.root", () => ({ value: setup.sessionRoot ?? "/work/app" }));
  on("session.repo", () => ({
    value:
      setup.repoRoot === undefined
        ? null
        : { root: setup.repoRoot, remote: null, internal: false, name: null },
  }));

  on("prompt.autocomplete", () => ({ suggestions: [] }));
  on("prompt.mention", ($, e) => {
    reads.push({ path: e.path, offset: e.offset, limit: e.limit });
    return setup.mentionResult ?? { type: "file" };
  });

  return { disk, reads, runs, clock, killGit: () => killGit?.() };
}
