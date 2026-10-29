import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { FRONTMATTER_PATTERN } from "./frontmatter";

export const BOM = "﻿";

export interface ScopePair {
  repository: string;
  area: string;
}

/**
 * A leading `<!-- mate:delta … -->` comment; group 1 is its YAML, the match ends after
 * the closing `-->` line. OpenSpec skips HTML comments, so a delta carrying its metadata
 * here passes `validate --strict`.
 */
export const DELTA_COMMENT_PATTERN =
  /^<!--[ \t]*mate:delta[ \t]*\r?\n([\s\S]*?)\r?\n-->[ \t]*(?:\r?\n|$)/;

/** Reads `scopes` from a `mate:delta` comment, else from frontmatter (proposals, legacy deltas). */
export function parseScopes(source: string): ScopePair[] {
  const text = source.startsWith(BOM) ? source.slice(BOM.length) : source;
  const match = DELTA_COMMENT_PATTERN.exec(text) ?? FRONTMATTER_PATTERN.exec(text);
  if (!match) return [];

  try {
    const parsed = parse(match[1]) as unknown;
    if (!parsed || typeof parsed !== "object") return [];
    const scopes = (parsed as Record<string, unknown>).scopes;
    if (!Array.isArray(scopes)) return [];
    return scopes.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const pair = entry as Record<string, unknown>;
      return typeof pair.repository === "string" && typeof pair.area === "string"
        ? [{ repository: pair.repository, area: pair.area }]
        : [];
    });
  } catch {
    return [];
  }
}

async function specFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return specFiles(full);
      return entry.isFile() && entry.name.endsWith(".md") ? [full] : [];
    }),
  );
  return nested.flat();
}

async function readOrEmpty(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * Repositories a change directory (active or archived) declares in its proposal
 * frontmatter and delta `scopes`, deduplicated case-insensitively, first spelling kept.
 */
export async function scopedRepositories(changeDir: string): Promise<string[]> {
  const sources = [
    await readOrEmpty(path.join(changeDir, "proposal.md")),
    ...(await Promise.all((await specFiles(path.join(changeDir, "specs"))).map(readOrEmpty))),
  ];
  const seen = new Map<string, string>();
  for (const pair of sources.flatMap(parseScopes)) {
    const key = pair.repository.toLowerCase();
    if (!seen.has(key)) seen.set(key, pair.repository);
  }
  return [...seen.values()];
}
