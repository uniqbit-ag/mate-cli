/** Dotted key path of each string under `value` that starts with `./` or `../`. */
function relativePathValues(value: unknown, at: string[]): string[] {
  if (typeof value === "string") {
    return value.startsWith("./") || value.startsWith("../") ? [at.join(".")] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => relativePathValues(entry, [...at, String(index)]));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) => relativePathValues(entry, [...at, key]));
  }
  return [];
}

/** One wrap warning per relative path under `value`; a fold reports them, never rewrites. */
export function relativePathWarnings(
  configPath: string,
  value: unknown,
  at: string[],
  target: { document: string; resolvesAgainst: string },
): string[] {
  return relativePathValues(value, at).map(
    (keyPath) =>
      `${configPath}: ${keyPath} is a relative path, which resolves against ${target.resolvesAgainst} once merged into ${target.document}; use an absolute path.`,
  );
}
