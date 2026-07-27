#!/bin/sh
set -u

input_file=$(mktemp "${TMPDIR:-/tmp}/mate-artifact-finish.XXXXXX")
trap 'rm -f "$input_file"' EXIT
cat >"$input_file"

node -e '
const fs = require("node:fs");

const inputFile = process.argv[1];
const archivePathPattern = /(?:^|[\s\/"\x27`,(])openspec\/changes\/archive\/(\d{4}-\d{2}-\d{2}-[^\/\s"\x27`,)]+)/;

function shellSplit(command) {
  const parts = [];
  const singleQuote = String.fromCharCode(39);
  let current = "";
  let quote = null;
  let escaping = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== singleQuote) {
      const next = command[index + 1] || "";
      if (next === "\\" || /\s/.test(next) || next === singleQuote || next === String.fromCharCode(34)) {
        escaping = true;
        continue;
      }
    }
    if ((char === singleQuote || char === String.fromCharCode(34)) && !quote) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

function extractChangeFromPath(value) {
  const match = value.replace(/\\/g, "/").match(archivePathPattern);
  return match ? match[1].replace(/^\d{4}-\d{2}-\d{2}-/, "") : null;
}

function extractArchiveCommand(command) {
  const parts = shellSplit(command);
  const index = parts.findIndex((part, position) =>
    part === "archive" && position > 0 &&
    (parts[position - 1] === "openspec" || parts[position - 1].endsWith("/openspec")));
  if (index < 0) return null;
  for (let position = index + 1; position < parts.length; position += 1) {
    const part = parts[position];
    if (!part || part === "--") continue;
    if (part.startsWith("-")) {
      if (part === "--store") position += 1;
      continue;
    }
    return part;
  }
  return null;
}

function extractMoveCommand(command) {
  const parts = shellSplit(command);
  const moveCommands = new Set([
    "mv", "move", "move-item", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
  ]);
  const isPython = (part) => /^python(?:\d(?:\.\d+)*)?(?:\.exe)?$/i.test(part.split(/[\\/]/).pop() || part);
  for (let index = 0; index < parts.length; index += 1) {
    if (moveCommands.has(parts[index].toLowerCase())) {
      for (const part of parts.slice(index + 1)) {
        const change = extractChangeFromPath(part);
        if (change) return change;
      }
    }
    if (isPython(parts[index]) && /(?:shutil\.move|os\.rename|\.rename\s*\()/.test(command)) {
      return extractChangeFromPath(command);
    }
  }
  return null;
}

let input = {};
try {
  input = JSON.parse(fs.readFileSync(inputFile, "utf8") || "{}");
} catch {}

if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") process.exit(0);
const command = input.tool_input && typeof input.tool_input.command === "string"
  ? input.tool_input.command
  : "";
const change = extractArchiveCommand(command) || extractMoveCommand(command);
if (!change) process.exit(0);

const reason =
  "Standalone archival for OpenSpec change " + change + " is blocked. Invoke the " +
  "mate-artifact-finish skill, then run `mate artifact finish \"" + change + "\" --json`. " +
  "The finish command performs the normal OpenSpec archive and completes commit, tag, and push.";
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  },
}));
' "$input_file"
exit 0
