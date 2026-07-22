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
