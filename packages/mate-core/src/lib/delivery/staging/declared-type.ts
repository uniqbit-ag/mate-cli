import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { companionGit, nulPaths } from "../../../runtime/companion-git";
import { changeNameOf, parseAnchor } from "../../change-layout";
import { pathIsDirectory } from "../../fs-utils";
import {
  type DeclaredArtifactType,
  WORKFLOW_FILE,
  type WorkflowHook,
} from "../../workflow/declaration";
import {
  companionIdentity,
  isCommandTrusted,
  type HookName,
  type ScopedCommand,
} from "../../workflow/hook-trust";
import {
  type ChangeFolders,
  declaredChangeFolders,
  isChangeFolderName,
} from "../../../runtime/workflow/change-folders";
import { folderPattern, matchesPattern } from "../../../runtime/workflow/globs";
import { FRAMEWORK_NAME } from "../../../runtime/framework";
import { DELIVERY_FILE } from "../record";
import type { ArtifactType } from "./artifact-type";

/** Bound on one `run:` command, so a hung one ends as that hook's failure. */
const RUN_TIMEOUT_MS = 120_000;

/** What a `run:` command's placeholders stand for; an absent one is the empty word. */
interface Placeholders {
  name: string;
  id?: string;
  change: string;
  archive?: string;
  files?: readonly string[];
}

/**
 * Each placeholder as a quoted variable reference, never spliced-in text: the shell expands a
 * value but never parses it, so a change or file name holding `$(…)` or a quote stays data
 * wherever the command quotes the placeholder. `{files}` is the positional parameters.
 */
const REFERENCES: Record<string, string> = {
  name: '"$MATE_NAME"',
  id: '"$MATE_ID"',
  change: '"$MATE_CHANGE"',
  archive: '"$MATE_ARCHIVE"',
  files: '"$@"',
};

function command(run: string): string {
  return run.replace(/\{(name|id|change|archive|files)\}/g, (_, key: string) => REFERENCES[key]!);
}

/** A relative path that cannot pass as an option: `-x` becomes `./-x`. */
const notOption = (file: string): string => (file.startsWith("-") ? `./${file}` : file);

/**
 * Secret-looking text in a failed command's output, masked: the output reaches the agent.
 * Assignments and headers naming a token, password or key, URL credentials, and well-known
 * token shapes. A `file.ext:line` value (`token: notes.md:12`) is a location, not a secret.
 */
export function maskSecrets(output: string): string {
  return output
    .replace(
      /\b([\w-]*(?:token|secret|passw(?:or)?d|api[_-]?key|private[_-]?key|authorization|credential)[\w-]*)(["']?\s*[:=]\s*["']?)(?:bearer\s+|basic\s+)?(?![\w./-]*\.\w+:\d+(?::\d+)?(?:$|[\s"',;]))[^\s"',;]+/gim,
      "$1$2***",
    )
    .replace(/\b(bearer|basic)\s+[\w.~+/=-]{8,}/gi, "$1 ***")
    .replace(/(:\/\/[^/\s:@]+:)[^@\s/]+@/g, "$1***@")
    .replace(
      /\b(?:gh[pousr]_\w{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|sk-[\w-]{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16})\b/g,
      "***",
    );
}

/** Whether this machine approved a `run:` command. */
export type CommandTrust = (command: ScopedCommand) => Promise<boolean>;

/**
 * Runs a hook in `dir`; null when it succeeds, else why it failed. A command this machine has
 * not approved for this companion never runs: anyone who can push to the companion can change it.
 */
async function runHook(
  hook: WorkflowHook,
  scope: { type: string; hook: HookName },
  dir: string,
  values: Placeholders,
  trusted: CommandTrust,
): Promise<string | null> {
  // Validation accepts no `builtin` name yet, so only `run` reaches here.
  if (!("run" in hook)) return `Mate ships no built-in hook named ${hook.builtin}`;
  const companion = await companionIdentity(dir);
  if (!(await trusted({ ...scope, run: hook.run, companion }))) {
    return `\`${hook.run}\` is not trusted for this companion on this machine; review it in ${WORKFLOW_FILE}, then run \`${FRAMEWORK_NAME} workflow trust\` in a terminal`;
  }
  const env = {
    ...process.env,
    MATE_NAME: values.name,
    MATE_ID: values.id ?? "",
    MATE_CHANGE: values.change,
    MATE_ARCHIVE: values.archive ?? "",
  };
  return new Promise((resolve) => {
    execFile(
      "sh",
      ["-c", command(hook.run), "sh", ...(values.files ?? []).map(notOption)],
      { cwd: dir, env, timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve(null);
        if (error.killed) return resolve(`\`${hook.run}\` ran out of time`);
        const output = (stderr || stdout).trim().split("\n").slice(-5).join("\n");
        resolve(maskSecrets(output) || `\`${hook.run}\` failed`);
      },
    );
  });
}

/** Why change `name` cannot be passed to a command or moved, or null. */
function nameProblem(folders: ChangeFolders, name: string): string | null {
  if (!isChangeFolderName(folders, name)) return `${name} is no change folder name`;
  if (name.startsWith("-")) return `${name} starts with \`-\`, which a command reads as an option`;
  return null;
}

/** Whether companion-relative `relative` reaches below `dir` without a symbolic link. */
async function withoutLinks(dir: string, relative: string): Promise<boolean> {
  let current = dir;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    // oxlint-disable-next-line no-await-in-loop -- each segment below the one before
    const entry = await fs.lstat(current).catch(() => null);
    if (entry === null) return true;
    if (entry.isSymbolicLink()) return false;
  }
  return true;
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** Today's local date, as OpenSpec dates an archive. */
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Paths that differ from `HEAD` in the checkout `dir`, untracked and ignored ones included:
 * publication adds them all.
 */
async function changedPaths(dir: string): Promise<string[]> {
  const status = await companionGit(dir, { prompt: "never" }).run([
    "status",
    "--porcelain=v1",
    "-z",
    "--no-renames",
    "--untracked-files=all",
    "--ignored=matching",
  ]);
  return nulPaths(status.stdout).map((entry) => entry.slice(3));
}

export interface DeclaredTypeOptions {
  /** The date a published record is named after, `YYYY-MM-DD`; today by default. */
  date?: () => string;
  /** Whether a `run:` command was approved; the approvals of `mate workflow trust` by default. */
  trusted?: CommandTrust;
}

/**
 * A type a companion declares in its workflow: change folders below `change`, hooks that run
 * the companion's own commands. Mate moves a published change's folder to `archive`, or deletes
 * it when the type keeps none, and refuses an `apply` that wrote outside the type's paths.
 */
export function declaredArtifactType(
  declared: DeclaredArtifactType,
  options: DeclaredTypeOptions = {},
): ArtifactType {
  const folders = declaredChangeFolders(declared);
  const { source, archiveRoot } = folders;
  const owned = [
    folderPattern(declared.change),
    ...(declared.archive === undefined ? [] : [folderPattern(declared.archive)]),
    ...declared.published,
  ];
  const changePath = (name: string): string => `${source}/${name}`;
  const trusted: CommandTrust = options.trusted ?? ((scoped) => isCommandTrusted(scoped));
  const scope = (hook: HookName) => ({ type: declared.name, hook });
  return {
    name: declared.name,
    source,
    ...(archiveRoot === undefined ? {} : { archiveRoot }),
    deliveryFile: DELIVERY_FILE,
    isRecordId: (id) => parseAnchor(id) !== null,
    recordName: changeNameOf,
    async check(dir, name) {
      const { check } = declared.hooks;
      if (!check) return null;
      return (
        nameProblem(folders, name) ??
        runHook(check, scope("check"), dir, { name, change: changePath(name) }, trusted)
      );
    },
    async apply(dir, name) {
      const invalid = nameProblem(folders, name);
      if (invalid) return { ok: false, detail: invalid };
      const id = `${(options.date ?? today)()}-${name}`;
      const change = changePath(name);
      const archive = archiveRoot === undefined ? undefined : `${archiveRoot}/${id}`;
      // The id is date and name only: never replace an earlier change's record.
      if (archive !== undefined && (await fs.lstat(path.join(dir, archive)).catch(() => null))) {
        return {
          ok: false,
          detail: `${archive} already holds a change named ${name} published today; publish this one on another day or under another name`,
        };
      }
      const failure = await runHook(
        declared.hooks.apply,
        scope("apply"),
        dir,
        { name, id, change, archive },
        trusted,
      );
      if (failure) return { ok: false, detail: failure };
      const outside = (await changedPaths(dir)).filter(
        (file) => !owned.some((pattern) => matchesPattern(pattern, file)),
      );
      if (outside.length > 0) {
        return {
          ok: false,
          detail: `its apply command changed ${outside.join(", ")}, outside the paths ${declared.name} declares`,
        };
      }
      const linked = [change, ...(archive === undefined ? [] : [archive])];
      for (const relative of linked) {
        // oxlint-disable-next-line no-await-in-loop -- a few paths
        if (!(await withoutLinks(dir, relative))) {
          return {
            ok: false,
            detail: `${relative} passes a symbolic link; Mate moves and deletes no folder through one`,
          };
        }
      }
      const folder = path.join(dir, ...change.split("/"));
      if (archive !== undefined && (await pathIsDirectory(folder))) {
        const target = path.join(dir, ...archive.split("/"));
        // Only what the apply command itself wrote there: an earlier record was refused above.
        await fs.rm(target, { recursive: true, force: true });
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rename(folder, target);
      } else {
        await fs.rm(folder, { recursive: true, force: true });
      }
      return { ok: true, record: id };
    },
    async validate(dir, files) {
      const { validate } = declared.hooks;
      const published = files.filter((file) =>
        declared.published.some((pattern) => matchesPattern(pattern, file)),
      );
      if (!validate || published.length === 0) return null;
      const failure = await runHook(
        validate,
        scope("validate"),
        dir,
        { name: "", change: "", files: published },
        trusted,
      );
      return failure ? { path: published[0]!, detail: failure } : null;
    },
    // Listed whether written yet or not: the reviewer is told what to expect.
    reviews: async () => [...declared.reviews],
  };
}
