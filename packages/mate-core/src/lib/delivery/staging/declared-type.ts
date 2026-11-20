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
import { isCommandTrusted } from "../../workflow/hook-trust";
import { folderPattern, matchesPattern, templateRoot } from "../../../runtime/workflow/globs";
import { FRAMEWORK_NAME } from "../../../runtime/framework";
import { DELIVERY_FILE } from "../record";
import type { ArtifactType } from "./artifact-type";

/** Bound on one `run:` command, so a hung one ends as that hook's failure. */
const RUN_TIMEOUT_MS = 120_000;

/** `value` as one POSIX shell word. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** What a `run:` command's placeholders stand for; an absent one is the empty word. */
interface Placeholders {
  name: string;
  id?: string;
  change: string;
  archive?: string;
  files?: readonly string[];
}

function command(run: string, values: Placeholders): string {
  const words: Record<string, string> = {
    name: shellQuote(values.name),
    id: shellQuote(values.id ?? ""),
    change: shellQuote(values.change),
    archive: shellQuote(values.archive ?? ""),
    files: (values.files ?? []).map(shellQuote).join(" "),
  };
  return run.replace(/\{(name|id|change|archive|files)\}/g, (_, key: string) => words[key]!);
}

/** Whether this machine approved a `run:` command. */
export type CommandTrust = (run: string) => Promise<boolean>;

/**
 * Runs a hook in `dir`; null when it succeeds, else why it failed. A command this machine has
 * not approved never runs: anyone who can push to the companion can change it.
 */
async function runHook(
  hook: WorkflowHook,
  dir: string,
  values: Placeholders,
  trusted: CommandTrust,
): Promise<string | null> {
  // Validation accepts no `builtin` name yet, so only `run` reaches here.
  if (!("run" in hook)) return `Mate ships no built-in hook named ${hook.builtin}`;
  if (!(await trusted(hook.run))) {
    return `\`${hook.run}\` is not trusted on this machine; review it in ${WORKFLOW_FILE}, then run \`${FRAMEWORK_NAME} workflow trust\` in a terminal`;
  }
  const line = command(hook.run, values);
  return new Promise((resolve) => {
    execFile(
      "sh",
      ["-c", line],
      { cwd: dir, timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve(null);
        if (error.killed) return resolve(`\`${hook.run}\` ran out of time`);
        const output = (stderr || stdout).trim().split("\n").slice(-5).join("\n");
        resolve(output || `\`${hook.run}\` failed`);
      },
    );
  });
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
  const source = templateRoot(declared.change);
  const archiveRoot = declared.archive === undefined ? undefined : templateRoot(declared.archive);
  const owned = [
    folderPattern(declared.change),
    ...(declared.archive === undefined ? [] : [folderPattern(declared.archive)]),
    ...declared.published,
  ];
  const changePath = (name: string): string => `${source}/${name}`;
  const trusted = options.trusted ?? isCommandTrusted;
  return {
    name: declared.name,
    source,
    ...(archiveRoot === undefined ? {} : { archiveRoot }),
    deliveryFile: DELIVERY_FILE,
    isRecordId: (id) => parseAnchor(id) !== null,
    recordName: changeNameOf,
    async check(dir, name) {
      const { check } = declared.hooks;
      return check ? runHook(check, dir, { name, change: changePath(name) }, trusted) : null;
    },
    async apply(dir, name) {
      const id = `${(options.date ?? today)()}-${name}`;
      const change = changePath(name);
      const archive = archiveRoot === undefined ? undefined : `${archiveRoot}/${id}`;
      const failure = await runHook(
        declared.hooks.apply,
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
      const folder = path.join(dir, ...change.split("/"));
      if (archive !== undefined && (await pathIsDirectory(folder))) {
        const target = path.join(dir, ...archive.split("/"));
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
