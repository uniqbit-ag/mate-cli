/**
 * Path patterns of a workflow declaration: companion-relative POSIX paths where `*` and `?`
 * match within one segment and `**` matches any number of segments.
 */

const segmentsOf = (pattern: string): string[] => pattern.split("/").filter(Boolean);

/** The folder a template such as `notes/{name}/` keeps its entries in: `notes`. */
export function templateRoot(template: string): string {
  return segmentsOf(template).slice(0, -1).join("/") || ".";
}

/** The pattern of every file inside the folders `template` names, its placeholder as `*`. */
export function folderPattern(template: string): string {
  return [...segmentsOf(template.replace(/\{[a-z]+\}/g, "*")), "*", "**"].join("/");
}

function segmentRegExp(segment: string): RegExp {
  const source = segment
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`);
}

function pathMatches(pattern: readonly string[], file: readonly string[], i = 0, j = 0): boolean {
  if (i === pattern.length) return j === file.length;
  if (pattern[i] === "**") {
    return (
      pathMatches(pattern, file, i + 1, j) ||
      (j < file.length && pathMatches(pattern, file, i, j + 1))
    );
  }
  if (j === file.length) return false;
  return segmentRegExp(pattern[i]!).test(file[j]!) && pathMatches(pattern, file, i + 1, j + 1);
}

/** True when `file` matches `pattern`. */
export function matchesPattern(pattern: string, file: string): boolean {
  return pathMatches(segmentsOf(pattern), segmentsOf(file));
}

function segmentsOverlap(a: string, b: string, i = 0, j = 0): boolean {
  if (i === a.length && j === b.length) return true;
  if (a[i] === "*") {
    return segmentsOverlap(a, b, i + 1, j) || (j < b.length && segmentsOverlap(a, b, i, j + 1));
  }
  if (b[j] === "*") {
    return segmentsOverlap(a, b, i, j + 1) || (i < a.length && segmentsOverlap(a, b, i + 1, j));
  }
  if (i === a.length || j === b.length) return false;
  if (a[i] === "?" || b[j] === "?" || a[i] === b[j]) return segmentsOverlap(a, b, i + 1, j + 1);
  return false;
}

function pathsOverlap(a: readonly string[], b: readonly string[], i = 0, j = 0): boolean {
  if (i === a.length && j === b.length) return true;
  if (a[i] === "**") {
    return pathsOverlap(a, b, i + 1, j) || (j < b.length && pathsOverlap(a, b, i, j + 1));
  }
  if (b[j] === "**") {
    return pathsOverlap(a, b, i, j + 1) || (i < a.length && pathsOverlap(a, b, i + 1, j));
  }
  if (i === a.length || j === b.length) return false;
  return segmentsOverlap(a[i]!, b[j]!) && pathsOverlap(a, b, i + 1, j + 1);
}

/** True when some path matches both patterns. */
export function patternsOverlap(a: string, b: string): boolean {
  return pathsOverlap(segmentsOf(a), segmentsOf(b));
}
