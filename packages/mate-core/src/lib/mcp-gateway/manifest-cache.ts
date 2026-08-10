import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { McpToolDescriptor } from "./tool-namespace";

export interface ManifestCacheEntry {
  /** `serverConfigHash` of the resolved definition — the cache key. */
  configHash: string;
  /** Raw backend descriptors; public `mate__` names derive deterministically at list time. */
  tools: McpToolDescriptor[];
  /** Display-only: what spawned, for `mate mcp status`. */
  command: string;
  updatedAt: string;
}

interface ManifestCacheFile {
  version: 1;
  manifests: Record<string, ManifestCacheEntry>;
}

/**
 * Persistent tool-manifest cache: answers `tools/list` without spawning.
 * Loaded lazily once; writes are atomic (temp + rename) so concurrent daemons
 * during a drain window cannot corrupt it.
 */
export class ManifestCache {
  readonly cachePath: string;
  private entries: Map<string, ManifestCacheEntry> | null = null;

  constructor(cachePath: string) {
    this.cachePath = cachePath;
  }

  private async ensureLoaded(): Promise<Map<string, ManifestCacheEntry>> {
    if (this.entries) return this.entries;
    this.entries = new Map();
    try {
      const raw = await fs.readFile(this.cachePath, "utf8");
      const parsed = JSON.parse(raw) as ManifestCacheFile;
      if (parsed && parsed.version === 1 && typeof parsed.manifests === "object") {
        for (const [key, entry] of Object.entries(parsed.manifests ?? {})) {
          if (entry && Array.isArray(entry.tools)) this.entries.set(key, entry);
        }
      }
    } catch {
      /* missing or corrupt cache — start empty; backends repopulate on demand */
    }
    return this.entries;
  }

  async get(configHash: string): Promise<ManifestCacheEntry | undefined> {
    return (await this.ensureLoaded()).get(configHash);
  }

  async set(configHash: string, tools: McpToolDescriptor[], command: string): Promise<void> {
    const entries = await this.ensureLoaded();
    entries.set(configHash, {
      configHash,
      tools,
      command,
      updatedAt: new Date().toISOString(),
    });
    await this.persist(entries);
  }

  async list(): Promise<ManifestCacheEntry[]> {
    return [...(await this.ensureLoaded()).values()];
  }

  private async persist(entries: Map<string, ManifestCacheEntry>): Promise<void> {
    const file: ManifestCacheFile = { version: 1, manifests: Object.fromEntries(entries) };
    await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
    const tempPath = `${this.cachePath}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
      await fs.rename(tempPath, this.cachePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}

/** Structural manifest equality — drift detection ignores key order. */
export function manifestsEqual(a: McpToolDescriptor[], b: McpToolDescriptor[]): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
