/**
 * Serializes the test files that rebuild Studio's `dist` with those that serve it: a rebuild
 * removes the files a running Studio imports. The lock sits in the run's isolated HOME, so a
 * killed run leaves none behind.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const LOCK = path.join(os.homedir(), "studio-dist.lock");

export async function lockStudioDist(): Promise<void> {
  for (;;) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- lock retry loop
      await fs.mkdir(LOCK);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // oxlint-disable-next-line no-await-in-loop -- lock retry loop
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function unlockStudioDist(): Promise<void> {
  await fs.rm(LOCK, { recursive: true, force: true });
}
