import { accessSync, constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export function isCommandOnPath(command: string, pathValue: string): boolean {
  if (!pathValue) return false;
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    try {
      accessSync(path.join(dir, command), constants.X_OK);
      return true;
    } catch {
      // continue
    }
  }
  return false;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function pathIsDirectory(candidatePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(candidatePath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Real path, so a Windows junction (read back `\\?\`-prefixed) or an aliased
 * spelling compares equal; resolved text when dangling.
 */
export async function realOrResolved(candidate: string): Promise<string> {
  return fs.realpath(candidate).catch(() => path.resolve(candidate));
}

/** {@link realOrResolved} for a link whose raw `readlink` text is `target`. */
export async function realLinkTarget(link: string, target: string): Promise<string> {
  return fs.realpath(link).catch(() => path.resolve(path.dirname(link), target));
}
