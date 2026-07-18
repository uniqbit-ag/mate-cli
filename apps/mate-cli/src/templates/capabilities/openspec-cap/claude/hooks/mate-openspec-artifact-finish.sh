#!/bin/sh
set -u

input_file=$(mktemp "${TMPDIR:-/tmp}/mate-openspec-artifact-finish.XXXXXX")
trap 'rm -f "$input_file"' EXIT
cat >"$input_file"

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
companion_path=${MATE_ARTIFACT_PATH:-}
if [ -z "$companion_path" ]; then
  companion_path=$(CDPATH= cd "$script_dir/../.." && pwd)
fi

archive_dir="$companion_path/openspec/changes/archive"
state_file="$companion_path/.claude/state/mate-openspec-artifact-finish.archive-snapshot.json"

node -e '
const fs = require("node:fs");
const path = require("node:path");

const archiveDir = process.argv[1];
const stateFile = process.argv[2];
const inputFile = process.argv[3];
const archiveEntryPattern = /^\d{4}-\d{2}-\d{2}-.+$/;
const archivePathPattern = /(?:^|[\s\/"\x27`,(])openspec\/changes\/archive\/(\d{4}-\d{2}-\d{2}-[^\/\s"\x27`,)]+)/;

function readArchiveEntries() {
  try {
    return fs.readdirSync(archiveDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && archiveEntryPattern.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

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

function commandSucceeded(value) {
  if (!value || typeof value !== "object") return true;
  const candidates = [value, value.result, value.output, value.tool_output, value.tool_response];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    if (typeof candidate.success === "boolean") return candidate.success;
    for (const key of ["exitCode", "exit_code", "status", "statusCode", "status_code"]) {
      const status = candidate[key];
      if (typeof status === "number") return status === 0;
      if (typeof status === "string" && status.trim()) return Number(status) === 0;
    }
  }
  return true;
}

function commandArchive(input) {
  if (!input || typeof input !== "object") return null;
  const toolName = String(input.tool_name || input.toolName || input.tool || "");
  if (toolName !== "Bash" || !commandSucceeded(input)) return null;
  const commands = [
    input.command,
    input.args?.command,
    input.tool_input?.command,
  ].filter((command) => typeof command === "string");
  for (const command of commands) {
    const change = extractArchiveCommand(command) || extractMoveCommand(command);
    if (change) return change;
  }
  return null;
}

let input = {};
try {
  input = JSON.parse(fs.readFileSync(inputFile, "utf8") || "{}");
} catch {}

const currentEntries = readArchiveEntries();
let previousEntries;
let validState = false;
try {
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  if (state && state.version === 1 && Array.isArray(state.entries) &&
      state.entries.every((entry) => typeof entry === "string" && archiveEntryPattern.test(entry))) {
    previousEntries = new Set(state.entries);
    validState = true;
  }
} catch {}

try {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, entries: currentEntries }) + "\n");
} catch {
  process.exit(0);
}

const commandChange = commandArchive(input);
if (commandChange) {
  const message =
    "An openspec change (" + commandChange + ") was just archived. Invoke the " +
    "mate-openspec-artifact-finish skill now to finish it (invoke the CLI as `mate`, never through a companion-local wrapper path or as `$MATE_COMPANION_BIN_PATH/mate`). " +
    "Follow the skill guardrails, including confirming with the user in chat before pushing.";
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message },
  }));
  process.exit(0);
}

if (!validState) process.exit(0);
const newlyArchived = currentEntries.filter((entry) => !previousEntries.has(entry));
if (newlyArchived.length === 0) process.exit(0);

const nudges = newlyArchived.map((entry) =>
  "An openspec change (" + entry.slice("YYYY-MM-DD-".length) + ") was just archived. Invoke the " +
  "mate-openspec-artifact-finish skill now to finish it (invoke the CLI as `mate`, never through a companion-local wrapper path or as `$MATE_COMPANION_BIN_PATH/mate`). " +
  "Follow the skill guardrails, including confirming with the user in chat before pushing.");
process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: nudges.join("\n\n") },
}));
' "$archive_dir" "$state_file" "$input_file"
exit 0
