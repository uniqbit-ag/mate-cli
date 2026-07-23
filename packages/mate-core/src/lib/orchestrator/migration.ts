// oxlint-disable no-await-in-loop
import fs from "node:fs/promises";
import path from "node:path";

import { parse, stringify } from "yaml";

export async function migrateRegistryData(filePath: string): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }

  const data = parse(raw);
  if (data && typeof data === "object" && "activeRepoId" in data) {
    const { activeRepoId: _removed, ...rest } = data as Record<string, unknown>;
    await fs.writeFile(filePath, stringify(rest), "utf8");
  }
}

export async function migrateConfigDir(currentDir: string, legacyDirs: string[]): Promise<void> {
  try {
    await fs.access(currentDir);
    return;
  } catch {
    // current dir missing — check legacy locations
  }

  for (const legacyDir of legacyDirs) {
    try {
      await fs.access(legacyDir);
      await fs.mkdir(path.dirname(currentDir), { recursive: true });
      await fs.rename(legacyDir, currentDir);
      process.stderr.write(`[migration] ${legacyDir} → ${currentDir}\n`);
      return;
    } catch {
      // this legacy dir also absent, try next
    }
  }
}
