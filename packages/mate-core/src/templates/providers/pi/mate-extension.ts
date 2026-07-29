import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import nodePath from "node:path";

type PiExtensionApi = {
  on(event: string, handler: (...args: unknown[]) => unknown): void;
};

function isWithin(child: string, parent: string): boolean {
  const relative = nodePath.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative));
}

function canonicalPath(input: string): string {
  let existingPath = nodePath.resolve(input);
  const missingSuffix: string[] = [];

  while (true) {
    try {
      lstatSync(existingPath);
      return nodePath.join(realpathSync(existingPath), ...missingSuffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = nodePath.dirname(existingPath);
      if (parent === existingPath) {
        throw new Error(`Unable to resolve path: ${input}`, { cause: error });
      }
      missingSuffix.unshift(nodePath.basename(existingPath));
      existingPath = parent;
    }
  }
}

function blockedPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath"]) {
    if (typeof value[key] !== "string") continue;
    const candidate = value[key] as string;
    const repoPath = process.env.MATE_REPO_PATH;
    const artifactPath = process.env.MATE_ARTIFACT_PATH;
    if (!repoPath || !artifactPath) return candidate;

    try {
      const resolvedRepoPath = canonicalPath(repoPath);
      const resolvedArtifactPath = canonicalPath(artifactPath);
      const resolvedCandidate = canonicalPath(nodePath.resolve(resolvedRepoPath, candidate));
      if (
        isWithin(resolvedCandidate, resolvedRepoPath) ||
        isWithin(resolvedCandidate, resolvedArtifactPath)
      ) {
        continue;
      }
    } catch {
      return candidate;
    }
    return candidate;
  }
  return undefined;
}

export default function matePiExtension(pi: PiExtensionApi): void {
  pi.on("before_agent_start", (event: { systemPrompt?: string }) => {
    const guidance = process.env.MATE_PI_GUIDANCE?.trim();
    if (!guidance) return;
    return {
      systemPrompt: [event.systemPrompt, guidance].filter(Boolean).join("\n\n"),
    };
  });

  pi.on("tool_call", (event: { toolName?: string; input?: unknown }) => {
    if (!event.toolName || !["write", "edit"].includes(event.toolName)) return;
    const path = blockedPath(event.input);
    if (path) {
      return {
        block: true,
        reason: `Mate blocked a write outside the linked repository and companion: ${path}`,
      };
    }
  });

  // Keep explicit lifecycle hooks registered so future capability handlers can
  // attach without changing the bundled extension loading contract.
  pi.on("session_start", () => undefined);
  pi.on("tool_result", () => undefined);
  pi.on("agent_end", () => {
    if (process.env.MATE_REACT_DOCTOR_ENABLED !== "1") return;
    const executable = process.env.MATE_REACT_DOCTOR_BIN_PATH;
    if (!executable) return;
    const result = spawnSync(
      executable,
      [
        "--yes",
        "--verbose",
        "--scope",
        "changed",
        "--base",
        "HEAD",
        "--blocking",
        "warning",
        "--no-score",
        "--max-duration",
        "30",
      ],
      { cwd: process.env.MATE_REPO_PATH, encoding: "utf8", stdio: "inherit" },
    );
    if (result.error || result.status !== 0) {
      console.error(`React Doctor reported issues (exit ${result.status ?? 1}).`);
    }
  });
  pi.on("session_shutdown", () => undefined);
}
