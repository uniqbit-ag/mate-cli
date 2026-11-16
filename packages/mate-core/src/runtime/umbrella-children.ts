import fs from "node:fs";
import path from "node:path";

import { escapeAttribute } from "./companion-instructions";
import { repoLocalRegistryPath } from "./repo-local";
import { umbrellaChildIdentities, type UmbrellaChild } from "./umbrella-folder";

/** Bounds of the listed form; the plain Claude hook holds 10,000 characters for the whole policy. */
const UMBRELLA_CHILDREN_LIMIT = 20;
export const UMBRELLA_CHILDREN_MAX_CHARS = 2500;

const SCOPE_SENTENCE =
  "Each child is a Working Repository of its own. The Working Repository of a piece of work is the child it concerns.";
const COUNT_ONLY_SENTENCE =
  "Too many to list. A child is a direct subfolder that is a Git checkout; `git -C <child> config --get remote.origin.url` gives its repository identity.";

/** The `umbrella-children` block; count only above either bound, since a partial list reads as whole. */
function renderUmbrellaChildren(folder: string, children: readonly UmbrellaChild[]): string {
  const open = `<umbrella-children folder="${escapeAttribute(folder)}" count="${children.length}">`;
  const close = "</umbrella-children>";
  if (children.length <= UMBRELLA_CHILDREN_LIMIT) {
    const listed = [
      open,
      ...children.map(
        (child) =>
          `  <child repository="${escapeAttribute(child.repository)}" folder="${escapeAttribute(path.basename(child.path))}" />`,
      ),
      `  ${SCOPE_SENTENCE}`,
      close,
    ].join("\n");
    if (listed.length <= UMBRELLA_CHILDREN_MAX_CHARS) return listed;
  }
  return [open, `  ${COUNT_ONLY_SENTENCE} ${SCOPE_SENTENCE}`, close].join("\n");
}

/**
 * The block for a session whose Working Repository is `folder`; empty unless it is an umbrella:
 * a linked folder with no Git layout (`umbrellaChildIdentities` checks that) and forge children.
 */
export function umbrellaChildrenBlock(folder: string): string {
  const resolved = path.resolve(folder);
  if (!fs.statSync(repoLocalRegistryPath(resolved), { throwIfNoEntry: false })?.isFile()) return "";
  const children = umbrellaChildIdentities(resolved);
  return children.length > 0 ? renderUmbrellaChildren(resolved, children) : "";
}
