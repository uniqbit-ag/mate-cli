/**
 * Shared by the setup writers and the Companion Instructions reader. In
 * `runtime/` because hooks may import nothing outside it.
 */

import { fencedRanges } from "./markdown-scan";

export interface ManagedBlockMarkers {
  start: string;
  end: string;
}

export function managedBlockMarkers(frameworkName: string, blockKey: string): ManagedBlockMarkers {
  return {
    start: `<!-- ${frameworkName}:managed:${blockKey} start -->`,
    end: `<!-- ${frameworkName}:managed:${blockKey} end -->`,
  };
}

export function companionBlockMarkers(frameworkName: string): ManagedBlockMarkers {
  const name = frameworkName.toUpperCase();
  return {
    start: `<!-- ${name}:COMPANION:START -->`,
    end: `<!-- ${name}:COMPANION:END -->`,
  };
}

/**
 * The plugin owning a block whose key is `<pluginId>:<content hash>`, the
 * shape every setup writer produces; a key without a hash is returned whole.
 */
export function managedBlockPluginId(blockKey: string): string {
  const separator = blockKey.lastIndexOf(":");
  return separator === -1 ? blockKey : blockKey.slice(0, separator);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches a start marker; group 1 is the key. Given `pluginId`, only that plugin's blocks match. */
export function managedBlockStartPattern(frameworkName: string, pluginId?: string): RegExp {
  const keyPattern = pluginId === undefined ? "[^\\s]+" : `${escapeRegExp(pluginId)}:[0-9a-f]+`;
  return new RegExp(`<!-- ${escapeRegExp(frameworkName)}:managed:(${keyPattern}) start -->`, "g");
}

export interface ManagedBlock {
  key: string;
  /** Offsets of the whole block, markers included. */
  start: number;
  end: number;
  body: string;
}

export function findManagedBlocks(text: string, frameworkName: string): ManagedBlock[] {
  const blocks: ManagedBlock[] = [];
  const fenced = fencedRanges(text);
  for (const match of text.matchAll(managedBlockStartPattern(frameworkName))) {
    /* A marker quoted in a code fence is an example, not a block. */
    if (fenced.some(([from, to]) => match.index >= from && match.index < to)) continue;
    const key = match[1]!;
    const { start, end } = managedBlockMarkers(frameworkName, key);
    const bodyStart = match.index + start.length;
    const endIndex = text.indexOf(end, bodyStart);
    if (endIndex === -1) continue;
    const previous = blocks.at(-1);
    if (previous && match.index < previous.end) continue;
    blocks.push({
      key,
      start: match.index,
      end: endIndex + end.length,
      body: text.slice(bodyStart, endIndex).trim(),
    });
  }
  return blocks;
}

export function stripManagedBlocks(text: string, frameworkName: string): string {
  let result = "";
  let cursor = 0;
  for (const block of findManagedBlocks(text, frameworkName)) {
    result += text.slice(cursor, block.start);
    cursor = block.end;
  }
  return result + text.slice(cursor);
}
