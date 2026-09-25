import fs from "node:fs";
import path from "node:path";

/**
 * Resolve the distribution package containing a CLI entrypoint.
 *
 * Missing manifests are skipped while walking upward; malformed manifests and
 * filesystem errors stop the search so callers cannot guess a package root.
 */
export function resolvePackageRoot(
  entrypoint: string | undefined,
  packageName: string,
): string | undefined {
  if (!entrypoint || !packageName) return undefined;

  let current: string;
  try {
    current = path.dirname(fs.realpathSync(entrypoint));
  } catch {
    return undefined;
  }

  while (true) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(current, "package.json"), "utf8"),
      ) as unknown;
      if (
        manifest &&
        typeof manifest === "object" &&
        (manifest as { name?: unknown }).name === packageName
      ) {
        return current;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }

    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
