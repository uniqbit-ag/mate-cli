import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { parse, stringify } from "yaml";

export abstract class YamlFileStore<T> {
  constructor(readonly configPath: string) {
    this.configPath = path.resolve(configPath);
  }

  protected abstract onMissing(): Promise<T>;

  async load(): Promise<T> {
    try {
      const raw = await fs.readFile(this.configPath, "utf8");
      return parse(raw) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return this.onMissing();
      }
      throw error;
    }
  }

  /** Writes via a sibling temp file + `fs.rename()` so a process killed mid-write cannot leave a truncated/corrupt file. */
  async save(data: T): Promise<void> {
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    const tempPath = `${this.configPath}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempPath, stringify(data), "utf8");
      await fs.rename(tempPath, this.configPath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}
