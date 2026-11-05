#!/usr/bin/env node
/**
 * Thin shim for src/hooks/tokensave-route.ts, loaded through ts-loader.mjs: the
 * installed plugin sits inside node_modules, where node's native type stripping is off.
 * Runs on every tokensave call, so it answers outside a linked worktree (a `.git`
 * file, not a folder) before loading any TypeScript.
 */
import fs from "node:fs";
import path from "node:path";

async function readInput() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/** True when the nearest `.git` at or above `directory` is a file: a linked worktree. */
function inLinkedWorktree(directory) {
  try {
    let current = fs.realpathSync(directory);
    for (;;) {
      const dotGit = fs.statSync(path.join(current, ".git"), { throwIfNoEntry: false });
      if (dotGit) return dotGit.isFile();
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  } catch {
    return false;
  }
}

try {
  const input = await readInput();
  if (typeof input?.cwd === "string" && inLinkedWorktree(input.cwd)) {
    await import("./ts-loader.mjs");
    const { buildTokensaveRoute } = await import("../../src/hooks/tokensave-route.ts");
    const { stdout } = buildTokensaveRoute(input);
    if (stdout) {
      process.stdout.on("error", () => {});
      process.stdout.write(stdout);
    }
  }
} catch {
  // Any failure passes the call unchanged.
}
process.exitCode = 0;
