import fs from "node:fs/promises";

import {
  resolveSessionEnvelope,
  type SessionEnvelope,
  type SessionEnvelopeRequest,
} from "../../../lib/orchestrator/session-envelope";
import { writeJsonStdout } from "../../write-json-stdout";

export type ClaudeHookEvent = "SessionStart" | "UserPromptSubmit";

export const workspaceResolveHookCommandDeps = {
  resolveSessionEnvelope,
  appendEnvironment: (envFile: string, entries: Record<string, string>) =>
    appendEnvironmentEntries(envFile, entries),
};

function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function appendEnvironmentEntries(
  envFile: string,
  entries: Record<string, string>,
): Promise<void> {
  const lines = Object.entries(entries).map(([key, value]) => `export ${key}=${shellQuote(value)}`);
  if (lines.length > 0) await fs.appendFile(envFile, `${lines.join("\n")}\n`, "utf8");
}

function sessionRequest(): SessionEnvelopeRequest {
  const companionPath = process.env.MATE_ARTIFACT_PATH;
  return {
    host: "claude-code",
    cwd: process.cwd(),
    ...(companionPath
      ? {
          selection: {
            companionPath,
            ...(process.env.MATE_REPO_ID ? { repositoryId: process.env.MATE_REPO_ID } : {}),
            ...(process.env.MATE_REPO_PATH ? { repositoryPath: process.env.MATE_REPO_PATH } : {}),
          },
        }
      : {}),
  };
}

function formatEnvelopeContext(envelope: SessionEnvelope): string {
  return [
    "Mate Session Envelope resolved.",
    `Repository Link: ${envelope.repositoryLink.repository.id}`,
    `Working repository: ${envelope.workingRepositoryPath}`,
    `Companion repository: ${envelope.companionRepositoryPath}`,
    `Permitted roots: ${envelope.permittedRoots.join(", ")}`,
    "",
    envelope.renderedGuidance,
  ].join("\n");
}

function formatDiagnostic(
  message: string,
  candidates: Array<{
    repository: { id: string; path: string };
    companionPath: string;
  }> = [],
): string {
  const candidateLines = candidates.length
    ? [
        "Matching Repository Links:",
        ...candidates.map(
          (candidate) =>
            `- ${candidate.repository.id}: ${candidate.repository.path} + ${candidate.companionPath}`,
        ),
      ]
    : [];
  return [
    `Mate Session Envelope was not resolved: ${message}`,
    ...candidateLines,
    "Run `mate workspace resolve --json` or set an explicit Repository Link before continuing.",
  ].join("\n");
}

function hookOutput(event: ClaudeHookEvent, additionalContext: string): object {
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext,
    },
  };
}

async function persistResolvedLink(envelope: SessionEnvelope): Promise<void> {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile) return;

  const entries = {
    MATE_REPO_PATH: envelope.workingRepositoryPath,
    MATE_ARTIFACT_PATH: envelope.companionRepositoryPath,
    MATE_REPO_ID: envelope.repositoryLink.repository.id,
  };
  const changed = Object.fromEntries(
    Object.entries(entries).filter(([key, value]) => process.env[key] !== value),
  );
  await workspaceResolveHookCommandDeps.appendEnvironment(envFile, changed);
}

/** Emits Claude Code hook context while keeping resolution and persistence fail-soft. */
export async function runWorkspaceResolveHookCommand(argv: string[] = []): Promise<void> {
  const event = readFlag(argv, "--event") as ClaudeHookEvent | undefined;
  if (event !== "SessionStart" && event !== "UserPromptSubmit") {
    process.exitCode = 1;
    return;
  }

  let context: string;
  try {
    const result = await workspaceResolveHookCommandDeps.resolveSessionEnvelope(sessionRequest());
    if (result.status === "resolved" && result.envelope) {
      await persistResolvedLink(result.envelope);
      context = formatEnvelopeContext(result.envelope);
    } else {
      const diagnostic = result.diagnostics[0];
      context = formatDiagnostic(
        diagnostic?.message ?? "No matching Repository Link.",
        diagnostic?.candidates,
      );
    }
  } catch (error) {
    context = formatDiagnostic(error instanceof Error ? error.message : String(error));
  }

  await writeJsonStdout(hookOutput(event, context));
}
