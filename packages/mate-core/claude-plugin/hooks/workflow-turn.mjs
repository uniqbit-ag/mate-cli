#!/usr/bin/env node
// Thin shim: hook logic lives in src/hooks/workflow-turn.ts, loaded through
// ts-loader.mjs because the installed plugin sits inside node_modules where
// node's native type stripping is disabled. The hook runs on every prompt,
// Bash call and stop, so an event that cannot concern a step is answered
// before loading any TypeScript: a Bash command that reports no step, a
// prompt that starts no skill, and a stop with no turn noted.
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
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

/** The session's state file, as stateFile() in src/hooks/workflow-turn.ts names it. */
function stateFile(session) {
  const uid = process.getuid?.();
  const dir = uid === undefined ? "mate-turn-hooks" : `mate-turn-hooks-${uid}`;
  return path.join(os.tmpdir(), dir, `${session.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

const input = await readInput();
const event = input?.hook_event_name;
const session = typeof input?.session_id === "string" ? input.session_id : "";
const command = input?.tool_input?.command;
const prompt = input?.prompt;
let load = true;
if (event === "PostToolUse" && input.tool_name === "Bash") {
  load = typeof command === "string" && /\bworkflow\s+done\b/.test(command);
} else if (session && event === "UserPromptSubmit" && typeof prompt === "string") {
  // Any runtime's skill prefix; a prompt without one starts no step and clears the last turn.
  load = /^\s*[/@$]/.test(prompt);
  try {
    if (!load) rmSync(stateFile(session), { force: true });
  } catch {
    // Best effort: the hook never fails a prompt.
  }
} else if (session && event === "Stop") {
  load = existsSync(stateFile(session));
}
if (load) {
  await import("./ts-loader.mjs");
  const { run } = await import("../../src/hooks/workflow-turn.ts");
  process.exitCode = await run(process.argv.slice(2), input);
}
