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

  async save(data: T): Promise<void> {
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    await fs.writeFile(this.configPath, stringify(data), "utf8");
  }
}
