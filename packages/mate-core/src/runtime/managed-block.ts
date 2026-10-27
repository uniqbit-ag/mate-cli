/**
 * Shared by the setup writers and the Companion Instructions reader. In
 * `runtime/` because hooks may import nothing outside it.
 */

import { fencedRanges, trimBlankLines } from "./markdown-scan";

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

/** A marker quoted in a code fence is an example, not a block. */
function inFence(fenced: readonly [number, number][], index: number): boolean {
  return fenced.some(([from, to]) => index >= from && index < to);
}

/** The first `marker` at or after `from` outside a code fence, or -1. */
function indexOutsideFence(
  text: string,
  marker: string,
  from: number,
  fenced: readonly [number, number][],
): number {
  let index = text.indexOf(marker, from);
  while (index !== -1 && inFence(fenced, index)) {
    index = text.indexOf(marker, index + marker.length);
  }
  return index;
}

/** Offsets of the first `MATE:COMPANION` block, markers included; `null` without one. */
export function findCompanionBlock(
  text: string,
  frameworkName: string,
): { start: number; end: number } | null {
  const { start, end } = companionBlockMarkers(frameworkName);
  const fenced = fencedRanges(text);
  const startIndex = indexOutsideFence(text, start, 0, fenced);
  if (startIndex === -1) return null;
  const endIndex = indexOutsideFence(text, end, startIndex + start.length, fenced);
  return endIndex === -1 ? null : { start: startIndex, end: endIndex + end.length };
}

export function findManagedBlocks(text: string, frameworkName: string): ManagedBlock[] {
  const blocks: ManagedBlock[] = [];
  const fenced = fencedRanges(text);
  for (const match of text.matchAll(managedBlockStartPattern(frameworkName))) {
    if (inFence(fenced, match.index)) continue;
    const key = match[1]!;
    const { start, end } = managedBlockMarkers(frameworkName, key);
    const bodyStart = match.index + start.length;
    const endIndex = indexOutsideFence(text, end, bodyStart, fenced);
    if (endIndex === -1) continue;
    const previous = blocks.at(-1);
    if (previous && match.index < previous.end) continue;
    blocks.push({
      key,
      start: match.index,
      end: endIndex + end.length,
      body: trimBlankLines(text.slice(bodyStart, endIndex)),
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
