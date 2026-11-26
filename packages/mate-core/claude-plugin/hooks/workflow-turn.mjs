#!/usr/bin/env node
// Thin shim: hook logic lives in src/hooks/workflow-turn.ts, loaded through
// ts-loader.mjs because the installed plugin sits inside node_modules where
// node's native type stripping is disabled. The hook runs on every prompt,
// Bash call and stop, so an event that cannot concern a step is answered
// before loading any TypeScript: a Bash command that reports no step, a
// prompt that starts no skill, and a stop with no turn noted.
import { existsSync, lstatSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isPrivateDir,
  mayReportStep,
  mayStartStep,
  sessionFileName,
  turnStateDir,
} from "../../src/runtime/turn-state.mjs";

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

/** The session's state file; null unless its folder is private. Checks only, never creates it. */
function stateFile(session) {
  // mateHome() without TypeScript; turn-state.test.ts pins the two together.
  const dir = turnStateDir(path.join(process.env.HOME || os.homedir(), ".mate"));
  try {
    if (!isPrivateDir(lstatSync(dir), process.getuid?.())) return null;
  } catch {
    return null;
  }
  return path.join(dir, sessionFileName(session));
}

const input = await readInput();
const event = input?.hook_event_name;
const session = typeof input?.session_id === "string" ? input.session_id : "";
const command = input?.tool_input?.command;
const prompt = input?.prompt;
let load = true;
if (event === "PostToolUse" && input.tool_name === "Bash") {
  load = typeof command === "string" && mayReportStep(command);
} else if (session && event === "UserPromptSubmit" && typeof prompt === "string") {
  // Any runtime's skill prefix; a prompt without one starts no step and clears the last turn.
  load = mayStartStep(prompt);
  try {
    const file = load ? null : stateFile(session);
    if (file) rmSync(file, { force: true });
  } catch {
    // Best effort: the hook never fails a prompt.
  }
} else if (session && event === "Stop") {
  const file = stateFile(session);
  load = file !== null && existsSync(file);
}
if (load) {
  await import("./ts-loader.mjs");
  const { run } = await import("../../src/hooks/workflow-turn.ts");
  process.exitCode = await run(process.argv.slice(2), input);
}
