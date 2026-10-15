import path from "node:path";

import type { Context } from "@opencode/plugin/promise/plugin";

import {
  companionForkRefusal,
  syncCompanionUnattended,
  unattendedSyncStalenessLines,
} from "../runtime/companion-sync";
import { hasLaunchEnvironment } from "../runtime/env";
import { MATE_ENV } from "../runtime/env-names";
import { resolveProjection } from "../runtime/projection";
import { checkSecretAccess, type SecretToolCall } from "../runtime/secret-guard";
import { readWrapStateSync } from "../runtime/wrap-state";
import {
  buildArtifactError,
  extractPatchAdditions,
  extractPatchPaths,
  isArtifactPath,
  normalizeTargetPath,
  shouldBlockArtifactWrite,
  type CompanionContext,
} from "./companion-policy";

/** The Working Repository above `directory`, when it is wrapped for OpenCode. */
export function repositoryWrappedForOpenCode(directory: string): string | undefined {
  const projection = resolveProjection(directory);
  if (!projection || !readWrapStateSync(projection.repoRoot).runtimes.has("opencode")) {
    return undefined;
  }
  return projection.repoRoot;
}

/**
 * Keyed by companion so a double-loaded plugin repairs at most once per
 * session, which is the guarantee the spec asks for.
 */
const repairedCompanions = new Set<string>();

/**
 * A fetch at session start, for a location Session Prepare does not serve.
 * In a repository wrapped for OpenCode the plugin's background sync performs
 * the same unattended operation, so this one steps aside. Elsewhere it only
 * tries the companion lock: a held lock means another sync is already on it.
 * The launch-environment gate comes first so a Managed Session does no Git
 * work at all; the consent gate is the operation's own.
 */
export async function repairCompanionGitOnce(
  context: CompanionContext,
  env: Record<string, string | undefined> = process.env,
  directory?: string,
): Promise<string[]> {
  if (
    !context.companionPath ||
    (hasLaunchEnvironment(env) &&
      (env[MATE_ENV.repositoryPath] !== undefined || env[MATE_ENV.gitAutoMode] !== "1"))
  )
    return [];
  if (directory && repositoryWrappedForOpenCode(directory)) return [];
  if (repairedCompanions.has(context.companionPath)) return [];
  repairedCompanions.add(context.companionPath);

  /**
   * Operator-facing only: a model told to run the command would run it
   * unattended. The V2 server API has no toast; the notes reach the operator
   * through the persisted record and the TUI's staleness lines.
   */
  return unattendedSyncStalenessLines(
    await syncCompanionUnattended(context.companionPath, { lock: "try" }),
    "opencode",
  );
}

/** Test seam: the once-per-session guard is process-wide by design. */
export function resetCompanionGitRepairGuard(): void {
  repairedCompanions.clear();
}

/**
 * Writing artifacts on top of a forked companion is the state in which the
 * eventual reconciliation destroys work. The verdict comes from `runtime/`, so
 * the Claude hook and this middleware refuse the same writes for the same
 * reason — including the launch-environment gate that keeps a Managed
 * Launch's Git decision authoritative for the session it started.
 */
export async function refuseForkedCompanionWrite(
  context: CompanionContext,
  filePath: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (!filePath || !isArtifactPath(filePath)) return;
  if (!normalizeTargetPath(context, filePath).startsWith(path.normalize(context.companionPath))) {
    return;
  }
  const refusal = await companionForkRefusal(env, context.companionPath);
  if (refusal) throw new Error(refusal);
}

/** OpenCode tool inputs in the shape the shared secret guard reads. */
function secretToolCall(
  context: CompanionContext,
  tool: string,
  args: Record<string, unknown>,
): SecretToolCall | null {
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const target = (value: unknown) => (text(value) ? normalizeTargetPath(context, text(value)) : "");
  switch (tool) {
    case "read":
      return { kind: "read", paths: [target(args.filePath)] };
    case "write":
      return {
        kind: "write",
        writes: [{ path: target(args.filePath), content: text(args.content) }],
      };
    case "edit":
      return {
        kind: "write",
        writes: [{ path: target(args.filePath), content: text(args.newString) }],
      };
    case "apply_patch":
      return {
        kind: "write",
        writes: extractPatchAdditions(text(args.patchText)).map((addition) => ({
          path: target(addition.path),
          content: addition.content,
        })),
      };
    case "bash":
      return { kind: "shell", command: text(args.command) };
    case "grep":
      return { kind: "search", paths: [target(args.path)], globs: [text(args.include)] };
    default:
      return null;
  }
}

/**
 * Rejects when the tool call touches a secret, or would write an artifact
 * outside the companion. Secrets are checked first, as in the Claude hook.
 */
export async function guardToolInput(
  context: CompanionContext,
  tool: string,
  input: unknown,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const args = (input ?? {}) as Record<string, unknown>;

  const secretCall = context.companionPath ? secretToolCall(context, tool, args) : null;
  if (secretCall) {
    const companionRoot = path.normalize(context.companionPath);
    const refusal = await checkSecretAccess(secretCall, {
      companionPath: context.companionPath,
      isCompanionPath: (filePath) => filePath.startsWith(companionRoot),
    });
    if (refusal) throw new Error(refusal);
  }
  const filePaths =
    tool === "write" || tool === "edit"
      ? [String(args.filePath ?? "")]
      : tool === "apply_patch"
        ? extractPatchPaths(String(args.patchText ?? ""))
        : [];

  for (const filePath of filePaths) {
    if (context.repositoryPath && filePath && shouldBlockArtifactWrite(context, filePath)) {
      throw new Error(buildArtifactError(context, filePath));
    }
    // oxlint-disable-next-line no-await-in-loop -- the first refusal wins
    await refuseForkedCompanionWrite(context, filePath, env);
  }
}

/**
 * Registers the companion guardrails on an OpenCode V2 plugin context.
 * The caller resolves `context` and skips this when no companion resolved;
 * `env` is the launch environment the caller decided to trust.
 */
export async function registerCompanionHooks(
  api: Context,
  context: CompanionContext,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  /**
   * Anything escaping the repair would cost the session every guardrail
   * below to save a synchronization that is optional by design.
   */
  await repairCompanionGitOnce(context, env, api.location.directory).catch(() => []);

  await api.tool.hook("execute.before", (event) =>
    guardToolInput(context, event.tool, event.input, env),
  );
}
