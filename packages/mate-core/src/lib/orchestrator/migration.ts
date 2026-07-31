import fs from "node:fs/promises";

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
