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
    .replace(/\*+/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`);
}

/**
 * Whether `a[i..]` and `b[j..]` match, each position pair decided once: `**` and `*` backtrack,
 * so without the memo a pattern with several of them takes exponential time.
 */
function memoMatch<T>(
  a: readonly T[],
  b: readonly T[],
  step: (i: number, j: number, match: (i: number, j: number) => boolean) => boolean,
): boolean {
  const seen = new Map<number, boolean>();
  const match = (i: number, j: number): boolean => {
    const key = i * (b.length + 1) + j;
    let known = seen.get(key);
    if (known === undefined) {
      known = step(i, j, match);
      seen.set(key, known);
    }
    return known;
  };
  return match(0, 0);
}

function pathMatches(pattern: readonly string[], file: readonly string[]): boolean {
  return memoMatch(pattern, file, (i, j, match) => {
    if (i === pattern.length) return j === file.length;
    if (pattern[i] === "**") return match(i + 1, j) || (j < file.length && match(i, j + 1));
    if (j === file.length) return false;
    return segmentRegExp(pattern[i]!).test(file[j]!) && match(i + 1, j + 1);
  });
}

/** True when `file` matches `pattern`. */
export function matchesPattern(pattern: string, file: string): boolean {
  return pathMatches(segmentsOf(pattern), segmentsOf(file));
}

function segmentsOverlap(a: string, b: string): boolean {
  return memoMatch([...a], [...b], (i, j, match) => {
    if (i === a.length && j === b.length) return true;
    if (a[i] === "*") return match(i + 1, j) || (j < b.length && match(i, j + 1));
    if (b[j] === "*") return match(i, j + 1) || (i < a.length && match(i + 1, j));
    if (i === a.length || j === b.length) return false;
    return (a[i] === "?" || b[j] === "?" || a[i] === b[j]) && match(i + 1, j + 1);
  });
}

function pathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  return memoMatch(a, b, (i, j, match) => {
    if (i === a.length && j === b.length) return true;
    if (a[i] === "**") return match(i + 1, j) || (j < b.length && match(i, j + 1));
    if (b[j] === "**") return match(i, j + 1) || (i < a.length && match(i + 1, j));
    if (i === a.length || j === b.length) return false;
    return segmentsOverlap(a[i]!, b[j]!) && match(i + 1, j + 1);
  });
}

/** True when some path matches both patterns. */
export function patternsOverlap(a: string, b: string): boolean {
  return pathsOverlap(segmentsOf(a), segmentsOf(b));
}
