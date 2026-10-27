// oxlint-disable no-await-in-loop
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

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
    /* Created with the mode so private contents are never readable; chmod then overrides the umask. */
    await fs.writeFile(
      tempPath,
      contents,
      mode === undefined ? "utf8" : { encoding: "utf8", mode },
    );
    if (mode !== undefined) await fs.chmod(tempPath, mode);
    await fs.rename(tempPath, target);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

const MAX_LINK_HOPS = 40;

/**
 * Follows a symlink chain to its end, which may not exist yet: a dangling link names where to create.
 * Link text is never normalized lexically: `..` after a directory symlink means the real parent.
 */
async function resolveLinkEnd(filePath: string): Promise<string> {
  let current = filePath;
  for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
    const parent = await fs.realpath(path.dirname(current));
    const entry = path.join(parent, path.basename(current));
    const link = await fs.readlink(entry).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EINVAL") return null;
      throw error;
    });
    if (link === null) return entry;
    current = path.isAbsolute(link) ? link : `${parent}${path.sep}${link}`;
  }
  throw Object.assign(new Error(`too many levels of symbolic links: ${filePath}`), {
    code: "ELOOP",
  });
}

/**
 * As `writeAtomic`, through a symlink: the link stays and its target is
 * replaced, or created when the link dangles. An existing file keeps its mode.
 */
export async function writeAtomicThroughLink(
  filePath: string,
  contents: string | Buffer,
): Promise<void> {
  const target = await resolveLinkEnd(filePath);
  const existing = await fs.stat(target).catch(() => null);
  await writeAtomic(target, contents, existing ? existing.mode & 0o7777 : undefined);
}
