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
    const next = command[index + 1] || "";
    const previous = command[index - 1] || "";
    const isControlOperator = !quote && (
      char === ";" || char === "|" ||
      (char === "&" && next !== ">" && previous !== ">" && previous !== "<")
    );
    if (isControlOperator) {
      if (current) parts.push(current);
      current = "";
      if ((char === "|" || char === "&") && next === char) {
        parts.push(char + next);
        index += 1;
      } else {
        parts.push(char);
      }
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

// Shell syntax tokens are never change-name positionals: separators end the
// archive invocation, redirections are skipped (a bare operator also consumes
// its target token).
const separatorPattern = /^(\|\|?|&&?|;)$/;
const redirectionPattern = /^(\d*(>>?|<)|&>>?)/;
const bareRedirectionPattern = /^(\d*(>>?|<)|&>>?)$/;

function extractArchiveCommand(command) {
  const parts = shellSplit(command);
  const index = parts.findIndex((part, position) =>
    part === "archive" && position > 0 &&
    (parts[position - 1] === "openspec" || parts[position - 1].endsWith("/openspec")));
  if (index < 0) return null;
  for (let position = index + 1; position < parts.length; position += 1) {
    const part = parts[position];
    if (!part || part === "--") continue;
    if (separatorPattern.test(part)) return null;
    if (redirectionPattern.test(part)) {
      if (bareRedirectionPattern.test(part)) position += 1;
      continue;
    }
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

// Nudge only on apparent success: stay silent on a clear failure indication,
// nudge when success is indicated or indeterminate.
function isClearFailure(response) {
  if (!response || typeof response !== "object") return false;
  if (response.success === false || response.is_error === true) return true;
  if (typeof response.error === "string" && response.error) return true;
  if (response.interrupted === true) return true;
  const exitCode = response.exit_code ?? response.exitCode;
  return typeof exitCode === "number" && exitCode !== 0;
}

let input = {};
try {
  input = JSON.parse(fs.readFileSync(inputFile, "utf8") || "{}");
} catch {}

if (input.hook_event_name !== "PostToolUse" || input.tool_name !== "Bash") process.exit(0);
const command = input.tool_input && typeof input.tool_input.command === "string"
  ? input.tool_input.command
  : "";
const change = extractArchiveCommand(command) || extractMoveCommand(command);
if (!change) process.exit(0);
if (isClearFailure(input.tool_response)) process.exit(0);

const mateCommand = process.env.MATE_COMMAND || "mate";
const context =
  "OpenSpec change " + change + " was just archived. Invoke the mate-artifact-finish " +
  "skill, then run `" + mateCommand + " artifact finish \"" + change + "\" --json` to complete the " +
  "finish workflow (commit, tag, and push).";
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: context,
  },
}));
' "$input_file"
exit 0
