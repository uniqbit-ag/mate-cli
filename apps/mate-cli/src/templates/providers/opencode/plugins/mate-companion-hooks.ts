import fs from "node:fs";
import path from "node:path";

import type { Plugin } from "@opencode-ai/plugin";

import {
  buildArtifactError,
  extractPatchPaths,
  readContext,
  shouldBlockArtifactWrite,
  type CompanionContext,
} from "./mate-companion-policy";

const ARCHIVE_ENTRY_PATTERN = /^\d{4}-\d{2}-\d{2}-.+$/;
const ARCHIVE_PATH_PATTERN =
  /(?:^|[\s/"'`,(])openspec\/changes\/archive\/(\d{4}-\d{2}-\d{2}-[^/\s"'`,)]+)/;

function readArchiveEntries(archiveDir: string): Set<string> {
  try {
    return new Set(
      fs
        .readdirSync(archiveDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && ARCHIVE_ENTRY_PATTERN.test(entry.name))
        .map((entry) => entry.name),
    );
  } catch {
    return new Set();
  }
}

function shellSplit(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      const next = command[index + 1] ?? "";
      if (/^[\\\s'"]$/.test(next)) {
        escaping = true;
        continue;
      }
      current += char;
      continue;
    }
    if ((char === "'" || char === '"') && !quote) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) parts.push(current);
  return parts;
}

function extractArchivedChangeFromPath(value: string): string | null {
  const normalized = value.replace(/\\/g, "/");
  const match = normalized.match(ARCHIVE_PATH_PATTERN);
  return match ? match[1].replace(/^\d{4}-\d{2}-\d{2}-/, "") : null;
}

function extractArchiveCommandChange(command: string): string | null {
  const parts = shellSplit(command);
  const archiveIndex = parts.findIndex(
    (part, index) =>
      part === "archive" &&
      index > 0 &&
      (parts[index - 1] === "openspec" || parts[index - 1].endsWith("/openspec")),
  );
  if (archiveIndex < 0) return null;

  for (let index = archiveIndex + 1; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part || part === "--") continue;
    if (part.startsWith("-")) {
      if (part === "--store") index += 1;
      continue;
    }
    return part;
  }
  return null;
}

function extractMoveArchiveChange(commandText: string): string | null {
  const parts = shellSplit(commandText);
  const moveCommands = new Set([
    "mv",
    "move",
    "move-item",
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
  ]);
  const isPython = (part: string) =>
    /^python(?:\d(?:\.\d+)*)?(?:\.exe)?$/i.test(part.split(/[\\/]/).pop() ?? part);

  for (let index = 0; index < parts.length; index += 1) {
    const command = parts[index].toLowerCase();
    if (moveCommands.has(command)) {
      for (const part of parts.slice(index + 1)) {
        const change = extractArchivedChangeFromPath(part);
        if (change) return change;
      }
    }
    if (isPython(parts[index]) && /(?:shutil\.move|os\.rename|\.rename\s*\()/.test(commandText)) {
      return extractArchivedChangeFromPath(commandText);
    }
  }
  return null;
}

function collectCommands(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const commands: string[] = [];
  if (typeof record.command === "string") commands.push(record.command);
  for (const key of ["args", "tool_input"] as const) {
    const nested = record[key];
    if (nested && typeof nested === "object") {
      const command = (nested as Record<string, unknown>).command;
      if (typeof command === "string") commands.push(command);
    }
  }
  return commands;
}

function commandSucceeded(value: unknown): boolean {
  if (!value || typeof value !== "object") return true;
  const record = value as Record<string, unknown>;
  const candidates = [
    record,
    record.result,
    record.output,
    record.tool_output,
    record.tool_response,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const result = candidate as Record<string, unknown>;
    if (typeof result.success === "boolean") return result.success;
    for (const key of ["exitCode", "exit_code", "status", "statusCode", "status_code"] as const) {
      const status = result[key];
      if (typeof status === "number") return status === 0;
      if (typeof status === "string" && status.trim()) return Number(status) === 0;
    }
  }
  return true;
}

function detectCommandArchive(input: unknown, output: unknown): string | null {
  if (!commandSucceeded(input) || !commandSucceeded(output)) return null;
  for (const command of [...collectCommands(input), ...collectCommands(output)]) {
    const change = extractArchiveCommandChange(command) ?? extractMoveArchiveChange(command);
    if (change) return change;
  }
  return null;
}

function detectNewlyArchivedChanges(archiveDir: string, snapshot: Set<string>): string[] {
  const current = readArchiveEntries(archiveDir);
  const newlyArchived = [...current].filter((entry) => !snapshot.has(entry)).toSorted();
  snapshot.clear();
  for (const entry of current) snapshot.add(entry);
  return newlyArchived;
}

function appendOpenSpecFinishNudge(
  context: CompanionContext,
  archiveSnapshot: Set<string>,
  nudgedCommandChanges: Set<string>,
  input: { tool?: unknown },
  output: { output?: string },
): void {
  if (!context.gitAutoModeEnabled) return;

  const archiveDir = path.join(context.companionPath, "openspec", "changes", "archive");
  const changes = detectNewlyArchivedChanges(archiveDir, archiveSnapshot).map((entry) =>
    entry.slice("YYYY-MM-DD-".length),
  );
  const commandChange =
    String(input.tool ?? "").toLowerCase() === "bash" ? detectCommandArchive(input, output) : null;
  if (commandChange && !nudgedCommandChanges.has(commandChange)) {
    changes.push(commandChange);
    nudgedCommandChanges.add(commandChange);
  }

  const uniqueChanges = changes.filter((change, index) => changes.indexOf(change) === index);
  if (uniqueChanges.length === 0) return;
  const nudges = uniqueChanges.map(
    (change) =>
      `ACTION REQUIRED: An openspec change (${change}) was just archived. ` +
      `Immediately invoke the mate-openspec-artifact-finish skill to complete the finish pipeline ` +
      "(invoke the CLI as `mate`, never through a companion-local wrapper path or as `" +
      "$MATE_COMPANION_BIN_PATH/mate`). " +
      `Follow the skill's guardrails, completing the non-interactive happy path without asking for confirmation.`,
  );
  output.output = [output.output, ...nudges]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
}

export const CompanionHooksPlugin: Plugin = async () => {
  const context = readContext(process.env.MATE_ARTIFACT_PATH ?? "");
  if (!context.companionPath || !context.repositoryPath) return {};

  const archiveDir = path.join(context.companionPath, "openspec", "changes", "archive");
  const archiveSnapshot = readArchiveEntries(archiveDir);
  const nudgedCommandChanges = new Set<string>();

  return {
    "tool.execute.before": async (
      input: { tool: unknown },
      output: { args: { filePath?: unknown; patchText?: unknown } | undefined },
    ) => {
      const toolName = String(input.tool ?? "");
      const args = output.args ?? {};
      if (["write", "edit"].includes(toolName)) {
        const filePath = String(args.filePath ?? "");
        if (filePath && shouldBlockArtifactWrite(context, filePath)) {
          throw new Error(buildArtifactError(context, filePath));
        }
      }
      if (toolName === "apply_patch") {
        for (const filePath of extractPatchPaths(String(args.patchText ?? ""))) {
          if (shouldBlockArtifactWrite(context, filePath)) {
            throw new Error(buildArtifactError(context, filePath));
          }
        }
      }
    },
    "tool.execute.after": async (
      input: { tool: unknown },
      output: { output?: string; metadata?: unknown },
    ) => {
      appendOpenSpecFinishNudge(context, archiveSnapshot, nudgedCommandChanges, input, output);
    },
  };
};

export default CompanionHooksPlugin;
