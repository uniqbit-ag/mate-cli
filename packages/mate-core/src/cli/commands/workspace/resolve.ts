import {
  resolveSessionEnvelope,
  type SessionEnvelopeRequest,
  type SessionEnvelopeSelection,
} from "../../../lib/orchestrator/session-envelope";
import { writeJsonStdout } from "../../write-json-stdout";

export const workspaceResolveCommandDeps = {
  resolveSessionEnvelope,
};

function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readFlags(argv: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1]) values.push(argv[index + 1]!);
  }
  return values;
}

/** Resolves a versioned Session Envelope without launching, editing, or writing runtime state. */
export async function runWorkspaceResolveCommand(argv: string[] = []): Promise<void> {
  if (!argv.includes("--json")) {
    process.stderr.write("mate: `workspace resolve` requires --json.\n");
    process.exitCode = 1;
    return;
  }

  const companionPath = readFlag(argv, "--companion");
  const repositoryId = readFlag(argv, "--repository");
  const repositoryPath = readFlag(argv, "--repository-path");
  const cwd = readFlag(argv, "--cwd") ?? process.cwd();
  const activePath = readFlag(argv, "--active");
  const host = readFlag(argv, "--host") ?? "workspace-command";
  const selection: SessionEnvelopeSelection | undefined = companionPath
    ? {
        companionPath,
        ...(repositoryId ? { repositoryId } : {}),
        ...(repositoryPath ? { repositoryPath } : {}),
      }
    : undefined;
  const request: SessionEnvelopeRequest = {
    host,
    cwd,
    ...(activePath ? { activePath } : {}),
    workspaceRoots: readFlags(argv, "--workspace-root"),
    ...(selection ? { selection } : {}),
  };

  try {
    const result = await workspaceResolveCommandDeps.resolveSessionEnvelope(request);
    await writeJsonStdout(result);
  } catch (error) {
    await writeJsonStdout({
      schemaVersion: 1,
      status: "diagnostic",
      diagnostics: [
        {
          code: "resolver-failed",
          message: error instanceof Error ? error.message : String(error),
          candidates: [],
        },
      ],
    });
  }
}
