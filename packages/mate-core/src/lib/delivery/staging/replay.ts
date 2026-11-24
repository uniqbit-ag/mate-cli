import fs from "node:fs/promises";
import path from "node:path";

import { archiveAnchors } from "../../change-layout";
import { reconcileMainSpecFrontmatter } from "../../openspec-canonical-frontmatter";
import type { RunOpenSpec } from "../../openspec-cli";
import { nulPaths, type CompanionGit } from "../../../runtime/companion-git";
import { endsRequirements, REQUIREMENT_HEADER } from "./requirement-blocks";

/** A delta OpenSpec could not apply: the capability and the requirement it names. */
export interface DeltaFailure {
  capability: string;
  requirement: string;
  /** Why OpenSpec refused the delta, as it said, e.g. `not found`. */
  reason?: string;
  /**
   * For a requirement changed since the delta base, the three texts to resolve it from: the
   * requirement at the base, the delta's version (null when the delta removes it or renames it
   * without modifying its new name), and the default branch's (null when removed there).
   */
  versions?: { base: string; ours: string | null; theirs: string | null };
  /**
   * For a stale requirement, whether applying the delta replaces the text the default branch
   * now holds: the delta modifies it, or renames it and modifies its target. A removal, a plain
   * rename (OpenSpec keeps the body) and a requirement removed there overwrite nothing.
   */
  overwrites?: boolean;
}

/** `record`: the archive the change became. */
export type ReplayResult =
  | { ok: true; record: string }
  | { ok: false; detail: string; failure?: DeltaFailure };

export interface ReplayOptions {
  /** Milliseconds before OpenSpec is killed. */
  timeout?: number;
}

function lastLines(text: string, count = 5): string {
  return text.trim().split("\n").slice(-count).join("\n");
}

/** The delta named in OpenSpec's `<capability> <SECTION> failed for header "..." - <reason>` line. */
export function deltaFailure(output: string): DeltaFailure | null {
  const match =
    /^(\S+) (?:ADDED|MODIFIED|REMOVED|RENAMED) failed for header "### Requirement: (.+?)"(?: - (.+))?/m.exec(
      output,
    );
  return match ? { capability: match[1]!, requirement: match[2]!, reason: match[3] } : null;
}

/** The canonical spec file of `capability`, relative to the companion root. */
export function capabilitySpecPath(capability: string): string {
  return `openspec/specs/${capability}/spec.md`;
}

/**
 * Each `### Requirement:` block of a canonical spec, by name, up to the next requirement or
 * `#`/`##` heading, as OpenSpec reads one.
 */
export function requirementBlocks(spec: string): Map<string, string> {
  const blocks = new Map<string, string>();
  let name: string | null = null;
  let lines: string[] = [];
  const flush = (): void => {
    if (name !== null) blocks.set(name, lines.join("\n").trim());
  };
  for (const line of spec.split("\n")) {
    const header = REQUIREMENT_HEADER.exec(line);
    if (header || endsRequirements(line)) {
      flush();
      name = header ? header[1]! : null;
      lines = [];
    } else if (name !== null) {
      lines.push(line);
    }
  }
  flush();
  return blocks;
}

/**
 * The existing requirements a delta spec changes: those under `MODIFIED` and `REMOVED`,
 * and the `FROM` names under `RENAMED`. `ADDED` ones are left out; OpenSpec refuses a
 * duplicate itself.
 */
export function changedRequirements(delta: string): string[] {
  const names: string[] = [];
  let section = "";
  for (const line of delta.split("\n")) {
    const heading = /^## (\w+) Requirements\s*$/.exec(line);
    if (heading) {
      section = heading[1]!;
      continue;
    }
    if (section === "MODIFIED" || section === "REMOVED") {
      const header = REQUIREMENT_HEADER.exec(line);
      if (header) names.push(header[1]!);
    } else if (section === "RENAMED") {
      const from = /FROM:\s*`?### Requirement:\s*(.+?)`?\s*$/.exec(line);
      if (from) names.push(from[1]!);
    }
  }
  return names;
}

/** The `TO` name of each requirement a delta renames, by its `FROM` name. */
function renamedRequirements(delta: string): Map<string, string> {
  const renamed = new Map<string, string>();
  let section = "";
  let from: string | null = null;
  for (const line of delta.split("\n")) {
    section = /^## (\w+) Requirements\s*$/.exec(line)?.[1] ?? section;
    if (section !== "RENAMED") continue;
    const part = /(FROM|TO):\s*`?### Requirement:\s*(.+?)`?\s*$/.exec(line);
    if (part?.[1] === "FROM") from = part[2]!;
    else if (part && from !== null) {
      renamed.set(from, part[2]!);
      from = null;
    }
  }
  return renamed;
}

async function shown(git: CompanionGit, spec: string): Promise<string | null> {
  const result = await git.run(["show", "--end-of-options", spec]);
  return result.status === 0 ? result.stdout : null;
}

/** Each delta spec of the change at `changePath` in `ref`: its path, capability and text. */
async function deltaSpecs(
  git: CompanionGit,
  ref: string,
  changePath: string,
): Promise<{ file: string; capability: string; delta: string }[]> {
  const specsDir = `${changePath}/specs/`;
  // NUL-separated, so Git leaves a non-ASCII path unquoted.
  const listed = await git.run(["ls-tree", "-r", "-z", "--name-only", ref, "--", specsDir]);
  if (listed.status !== 0) return [];
  const files = nulPaths(listed.stdout).filter((entry) => entry.endsWith("/spec.md"));
  const deltas = await Promise.all(files.map((file) => shown(git, `${ref}:${file}`)));
  return files.flatMap((file, index) =>
    deltas[index] === null
      ? []
      : [
          {
            file,
            capability: file.slice(specsDir.length, -"/spec.md".length),
            delta: deltas[index]!,
          },
        ],
  );
}

/** The bodies of the requirements under a delta's `MODIFIED` section, by name. */
function modifiedRequirements(delta: string): Map<string, string> {
  const modified: string[] = [];
  let section = "";
  for (const line of delta.split("\n")) {
    section = /^## (\w+) Requirements\s*$/.exec(line)?.[1] ?? section;
    if (section === "MODIFIED") modified.push(line);
  }
  return requirementBlocks(modified.join("\n"));
}

/**
 * The first requirement the change at `changePath` in `ref` modifies, removes or renames that
 * changed between `base`, the commit its deltas were written against, and `current`, the
 * default tip before its group; null when none did. Applying the delta would overwrite that
 * change, since OpenSpec replaces whole blocks. A modification identical to the current text
 * changes nothing and passes; requirements in `skip` are passed over.
 */
export async function staleRequirement(
  git: CompanionGit,
  ref: string,
  changePath: string,
  base: string,
  current: string,
  skip: readonly Pick<DeltaFailure, "capability" | "requirement">[] = [],
): Promise<DeltaFailure | null> {
  for (const { capability, delta } of await deltaSpecs(git, ref, changePath)) {
    const names = changedRequirements(delta).filter(
      (name) => !skip.some((part) => part.capability === capability && part.requirement === name),
    );
    if (names.length === 0) continue;
    const specPath = capabilitySpecPath(capability);
    // oxlint-disable-next-line no-await-in-loop -- a handful of capabilities per archive
    const [before, now] = await Promise.all([
      shown(git, `${base}:${specPath}`),
      shown(git, `${current}:${specPath}`),
    ]);
    const was = requirementBlocks(before ?? "");
    const is = requirementBlocks(now ?? "");
    const modified = modifiedRequirements(delta);
    const renamed = renamedRequirements(delta);
    // The delta's body of a requirement: under its own name, or under the name it renames it to.
    const ours = (name: string): string | undefined =>
      modified.get(name) ?? modified.get(renamed.get(name) ?? "");
    const moved = names.find(
      (name) => was.has(name) && was.get(name) !== is.get(name) && ours(name) !== is.get(name),
    );
    if (moved !== undefined) {
      return {
        capability,
        requirement: moved,
        overwrites: is.has(moved) && ours(moved) !== undefined,
        versions: {
          base: was.get(moved)!,
          ours: ours(moved) ?? null,
          theirs: is.get(moved) ?? null,
        },
      };
    }
  }
  return null;
}

/**
 * Rewrites the `MODIFIED` body of `part`'s requirement in the change at `changeDir` to `text`,
 * as a resolved conflict reads; for a requirement the delta renames, the body under its new
 * name. Returns why it could not, or null.
 */
export async function resolveRequirement(
  changeDir: string,
  part: Pick<DeltaFailure, "capability" | "requirement">,
  text: string,
): Promise<string | null> {
  const segments = part.capability.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === ".." || segment.includes("\\"),
    )
  ) {
    return `${part.capability} is no capability name`;
  }
  const file = path.join(changeDir, "specs", ...segments, "spec.md");
  const delta = await fs.readFile(file, "utf8").catch(() => null);
  if (delta === null) return `${part.capability} has no delta spec in this change`;
  const lines = delta.split("\n");
  const names = new Set([part.requirement]);
  const target = renamedRequirements(delta).get(part.requirement);
  if (target !== undefined) names.add(target);
  let section = "";
  for (const [index, line] of lines.entries()) {
    const heading = /^## (\w+) Requirements\s*$/.exec(line);
    if (heading) {
      section = heading[1]!;
      continue;
    }
    if (section !== "MODIFIED" || !names.has(REQUIREMENT_HEADER.exec(line)?.[1] ?? "")) continue;
    let end = index + 1;
    while (
      end < lines.length &&
      !REQUIREMENT_HEADER.test(lines[end]!) &&
      !endsRequirements(lines[end]!)
    ) {
      end += 1;
    }
    const body = text.trim();
    if (REQUIREMENT_HEADER.test(body.split("\n")[0] ?? "")) {
      return "the resolved text is the requirement's body; leave out its heading";
    }
    // A later heading would end the block and add requirements or sections nothing checked.
    if (
      body.split("\n").some((entry) => REQUIREMENT_HEADER.test(entry) || endsRequirements(entry))
    ) {
      return "the resolved text is one requirement's body; it holds a `#`, `##` or `### Requirement:` heading";
    }
    lines.splice(index + 1, end - index - 1, ...body.split("\n"), "");
    // oxlint-disable-next-line no-await-in-loop -- returns after this one write
    await fs.writeFile(file, lines.join("\n"));
    return null;
  }
  return `"${part.requirement}" is not modified in ${part.capability}'s delta; edit that delta by hand`;
}

/**
 * Archives active change `change` in `dir` as `openspec archive` does, and reconciles the
 * frontmatter of the main specs it wrote. OpenSpec dates the archive today.
 */
export async function replayArchive(
  dir: string,
  change: string,
  runner: RunOpenSpec,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const before = new Set(await archiveAnchors(dir, change));
  // After `--`, so a name like an option is never parsed as one.
  const run = await runner(["archive", "--yes", "--", change], {
    cwd: dir,
    ...(options.timeout === undefined ? {} : { timeout: Math.max(1, options.timeout) }),
  });
  if (run.code !== 0) {
    const output = `${run.stdout}\n${run.stderr}`;
    const failure = deltaFailure(output);
    return {
      ok: false,
      detail:
        run.code === null
          ? `openspec archive ${change} ran out of time`
          : lastLines(run.stderr || run.stdout),
      ...(failure ? { failure } : {}),
    };
  }
  const record = (await archiveAnchors(dir, change)).find((name) => !before.has(name));
  if (!record) return { ok: false, detail: `openspec archive ${change} produced no archive` };
  await reconcileMainSpecFrontmatter(dir, record);
  return { ok: true, record };
}
