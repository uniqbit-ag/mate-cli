import fs from "node:fs";
import path from "node:path";

/** Shared by the Tool Guard and every companion-path entry, so all resolve `link/..` the same way. */

const MAX_SYMLINKS = 40;
export const PATH_SEPARATORS = path.sep === "\\" ? /[\\/]/ : /\//;

/**
 * Where the kernel would land `target`: a link is followed before a later `..`
 * applies, so `link/..` is the link target's parent (unlike `path.normalize`
 * and `fs.realpathSync`). Missing segments stay as written; the existing part
 * is spelled as on disk, so case-insensitive filesystems compare equal.
 */
export function physicalPath(target: string): string {
  return onDiskSpelling(walkSegments(target));
}

/**
 * `target` made absolute against `base` without normalising it: `link/..`
 * must stay for the kernel, and for {@link physicalPath}, to resolve.
 */
export function absoluteAsWritten(target: string, base: string): string {
  return path.isAbsolute(target) ? target : `${base}${path.sep}${target}`;
}

/**
 * Absolute and normalised, unless a link before a `..` makes the normalised
 * spelling name another folder; then {@link physicalPath}. Only a path with
 * `..` touches the filesystem; a missing one stays as written.
 */
export function canonicalPath(target: string): string {
  if (!target) return target;
  const normalised = path.resolve(target);
  if (!target.split(PATH_SEPARATORS).includes("..")) return normalised;
  if (!fs.existsSync(target)) return target;
  const physical = physicalPath(target);
  return physicalPath(normalised) === physical ? normalised : physical;
}

export const foldCase = (filePath: string) => filePath.normalize("NFC").toLowerCase();

/** Lexical containment; only a whole `..` segment leaves `root` (`root/..notes` is inside). */
export function isWithin(target: string, root: string): boolean {
  const relative = path.relative(path.normalize(root), path.normalize(target));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * Links are already followed, so the real path may only change letter case;
 * any other answer is distrusted (Bun's `realpathSync.native` drops a trailing
 * backslash: `/x/a\` answers `/x/a`).
 */
function onDiskSpelling(walked: string): string {
  const missing: string[] = [];
  for (let existing = walked; ; existing = path.dirname(existing)) {
    const real = realPathOrNull(existing);
    if (real !== null && foldCase(real) === foldCase(existing)) {
      return path.join(real, ...missing);
    }
    if (path.dirname(existing) === existing) return walked;
    missing.unshift(path.basename(existing));
  }
}

function realPathOrNull(filePath: string): string | null {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return null;
  }
}

function walkSegments(target: string): string {
  const absolute = path.isAbsolute(target) ? target : `${process.cwd()}${path.sep}${target}`;
  const { root } = path.parse(absolute);
  const pending = absolute.slice(root.length).split(PATH_SEPARATORS);
  let current = root;
  let links = 0;
  while (pending.length > 0) {
    const segment = pending.shift() as string;
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      current = path.dirname(current);
      continue;
    }
    const candidate = path.join(current, segment);
    const link = links < MAX_SYMLINKS ? readLink(candidate) : null;
    if (link === null) {
      current = candidate;
      continue;
    }
    links++;
    const linkRoot = path.parse(link).root;
    if (linkRoot) current = linkRoot;
    pending.unshift(...link.slice(linkRoot.length).split(PATH_SEPARATORS));
  }
  return current;
}

function readLink(candidate: string): string | null {
  try {
    return fs.lstatSync(candidate).isSymbolicLink() ? fs.readlinkSync(candidate) : null;
  } catch {
    return null;
  }
}
