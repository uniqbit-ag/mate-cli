import crypto from "node:crypto";
import fs from "node:fs/promises";

/**
 * Writes via a sibling temp file + `fs.rename()` so an interrupted write cannot
 * leave a half-written document behind. A reader racing this one — a Claude
 * Code session holding `~/.claude.json` open — observes the old file or the new
 * one, never a truncated one.
 */
export async function writeAtomic(
  target: string,
  contents: string | Buffer,
  mode?: number,
): Promise<void> {
  const tempPath = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(
      tempPath,
      contents,
      mode === undefined ? "utf8" : { encoding: "utf8", mode },
    );
    await fs.rename(tempPath, target);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}
