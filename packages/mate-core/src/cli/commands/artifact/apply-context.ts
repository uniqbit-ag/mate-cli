import fs from "node:fs/promises";
import path from "node:path";

import {
  fingerprintArtifacts,
  type FingerprintOptions,
  type FingerprintResult,
} from "../../../lib/apply-context/fingerprint";
import {
  compactableTasks,
  computeDigest,
  encodeApplyContext,
  fullReason,
  isWellFormedDigest,
  type ApplyPayload,
  type DigestIdentity,
} from "../../../lib/apply-context/protocol";
import { hasOpenspecCapability } from "../../../lib/orchestrator/capabilities";
import {
  resolveForCapability,
  type LaunchContext,
} from "../../../lib/orchestrator/framework-context";
import type { CapabilityConfig } from "../../../lib/orchestrator/types";
import { WorkingRepoRequiredError } from "../../../lib/orchestrator/types";
import { locateOpenSpec, runOpenSpec, type RunOpenSpec } from "../../../lib/openspec-cli";
import { generatedHeader } from "../../../runtime/projection";
import { parseSecretsConfig, type SecretPolicy } from "../../../runtime/secret-patterns";
import { type BooleanFlagSet, parseFlags, positionalArgs, stringFlag } from "../../parse-flags";
import { ensureUnambiguousCompanion } from "../shared/companion-selection";
import { commandOutput } from "./delivery/output";

export interface ApplyContextCommandDeps {
  cwd?: () => string;
  ensureUnambiguousCompanion?: (cwd: string) => Promise<boolean>;
  resolveContext?: (cwd: string) => Promise<LaunchContext>;
  loadCapabilities?: (context: LaunchContext) => Promise<CapabilityConfig[]>;
  loadSecretPolicy?: (context: LaunchContext) => Promise<SecretPolicy>;
  run?: RunOpenSpec;
  /** The upstream producer's identity; a new OpenSpec version invalidates every baseline. */
  producer?: () => Record<string, unknown>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const BOOLEAN_FLAGS: BooleanFlagSet = new Set(["json"]);

/** Upper bound on one upstream call, as Studio uses; a hung CLI fails the command. */
const OPENSPEC_TIMEOUT_MS = 60_000;

/** Attempts before a context that keeps changing during collection is sent without a digest. */
const COLLECTION_ATTEMPTS = 3;

async function defaultLoadCapabilities(context: LaunchContext): Promise<CapabilityConfig[]> {
  return (await context.configStore.load()).capabilities ?? [];
}

async function defaultLoadSecretPolicy(context: LaunchContext): Promise<SecretPolicy> {
  const config = (await context.configStore.load()) as { secrets?: unknown };
  return parseSecretsConfig(config.secrets);
}

function isUnder(child: string, root: string): boolean {
  const relative = path.relative(root, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function physical(dir: string): Promise<string> {
  return fs.realpath(dir).catch(() => path.resolve(dir));
}

/**
 * The directory the wrapped `openspec instructions` runs in: the Working Repository
 * root when the caller is inside it, outside the companion, and the root carries
 * Mate's store pointer; otherwise the companion. Mirrors `wrappers/bin/openspec`.
 */
export async function wrappedOpenSpecCwd(
  companionPath: string,
  repoPath: string | undefined,
  cwd: string,
): Promise<{ cwd: string; notice?: string }> {
  if (!repoPath) return { cwd: companionPath };
  const repoRoot = await physical(repoPath);
  const here = await physical(cwd);
  const companionRoot = await physical(companionPath);
  if (!isUnder(here, repoRoot) || isUnder(here, companionRoot)) return { cwd: companionPath };
  const pointer = path.join(repoRoot, "openspec", "config.yaml");
  const first = await fs
    .readFile(pointer, "utf8")
    .then((text) => text.split("\n")[0])
    .catch(() => undefined);
  if (first !== undefined) {
    return first === generatedHeader() ? { cwd: repoRoot } : { cwd: companionPath };
  }
  const hasYml = await fs
    .access(path.join(repoRoot, "openspec", "config.yml"))
    .then(() => true)
    .catch(() => false);
  if (hasYml) return { cwd: companionPath };
  return {
    cwd: companionPath,
    notice: `openspec: no OpenSpec store pointer in ${repoRoot}, so edits are scoped to the companion — run \`mate wrap\` to enable Working Repository edit roots`,
  };
}

function failureDetail(stdout: string, stderr: string): string {
  return (stderr.trim() || stdout.trim()).split("\n").slice(-3).join("; ");
}

function parsePayload(stdout: string): ApplyPayload | undefined {
  const text = stdout.trim();
  const candidates = [text, text.slice(Math.max(0, text.indexOf("{")))];
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return value as ApplyPayload;
      }
      return undefined;
    } catch {
      // Try the next candidate: text before the JSON object, such as a notice.
    }
  }
  return undefined;
}

function sameHashes(a: FingerprintResult, b: FingerprintResult): boolean {
  if (!a.ok || !b.ok) return false;
  return JSON.stringify(a.raw) === JSON.stringify(b.raw);
}

interface Collected {
  payload: ApplyPayload;
  /** Null when compaction is unavailable; `limitation` then says why. */
  digest: string | null;
  limitation?: string;
}

/**
 * Fetches the payload and fingerprints its artifacts twice; a digest only when both passes
 * agree. Retries a context that changes during collection. A string is an upstream failure.
 */
async function collect(
  fetchPayload: () => Promise<ApplyPayload | string>,
  identity: DigestIdentity,
  options: FingerprintOptions,
): Promise<Collected | string> {
  for (let attempt = 1; ; attempt++) {
    const payload = await fetchPayload();
    if (typeof payload === "string") return payload;
    const shape = compactableTasks(payload);
    if (!shape.ok) {
      // A blocked payload goes out in full anyway; its missing tasks are no limitation.
      const limitation = fullReason(payload) === null ? shape.reason : undefined;
      return { payload, digest: null, limitation };
    }
    let limitation: string;
    const first = await fingerprintArtifacts(payload, options);
    if (first.ok) {
      const second = await fingerprintArtifacts(payload, options);
      if (sameHashes(first, second)) {
        return { payload, digest: computeDigest(identity, payload, first.fingerprints) };
      }
      limitation = "context changed while it was collected";
    } else {
      limitation = first.reason;
      // A state mismatch can be a checkbox written between the upstream read and ours.
      if (!first.reason.includes("state differs")) return { payload, digest: null, limitation };
    }
    if (attempt === COLLECTION_ATTEMPTS) return { payload, digest: null, limitation };
  }
}

/**
 * @command mate artifact apply-context <change>
 * @description Fetches fresh `openspec instructions apply --json` for a change, resolved as
 * the wrapped `openspec` resolves it, and wraps it in a versioned envelope for Mate's opt-in
 * compact apply transport. Without a matching `--since` it emits the full upstream payload
 * with a baseline `digest`; with one it emits only `state`, `progress`, and every ordered
 * task `{id, done}`. Warnings, a blocked state, missing artifacts, and any change to the
 * static payload, referenced artifacts, edit context, or OpenSpec version force a full
 * envelope. Read-only: no writes, no forge or network access, no initialization.
 * @flags
 * - `--json` — required; emit the envelope as JSON.
 * - `--since <digest>` — the digest of a full envelope still held in full by the caller.
 * @remarks Upstream failures, timeouts, and malformed output exit non-zero; nothing is cached
 * or inferred. A full envelope with `digest: null` names its `limitation`, such as an
 * unreadable context file or an ambiguous task location.
 */
export async function runArtifactApplyContextCommand(
  argv: string[],
  deps: ApplyContextCommandDeps = {},
): Promise<void> {
  const { emitOut, emitErr, refuse } = commandOutput(deps);
  const flags = parseFlags(argv, BOOLEAN_FLAGS);
  const changes = positionalArgs(argv, BOOLEAN_FLAGS);
  if (changes.length !== 1) return refuse("mate: artifact apply-context requires one change name.");
  if (flags.json !== true) return refuse("mate: artifact apply-context requires --json.");
  const since = flags.since === undefined ? undefined : stringFlag(flags.since);
  if (flags.since !== undefined && since === undefined) {
    return refuse("mate: --since expects a digest.");
  }
  const change = changes[0];

  const cwd = (deps.cwd ?? (() => process.cwd()))();
  if (!(await (deps.ensureUnambiguousCompanion ?? ensureUnambiguousCompanion)(cwd))) {
    return refuse();
  }
  let context: LaunchContext;
  try {
    context = await (deps.resolveContext ?? ((dir: string) => resolveForCapability(dir)))(cwd);
  } catch (err) {
    if (err instanceof WorkingRepoRequiredError) return refuse(err.message);
    throw err;
  }
  const capabilities = await (deps.loadCapabilities ?? defaultLoadCapabilities)(context);
  if (!hasOpenspecCapability(capabilities)) {
    return refuse("mate: the openspec capability must be enabled to read apply context.");
  }

  const repoPath = context.repository?.path ?? process.env.MATE_REPO_PATH;
  const target = await wrappedOpenSpecCwd(context.companionPath, repoPath, cwd);
  if (target.notice) emitErr(target.notice);
  const run = deps.run ?? runOpenSpec;
  const args = ["instructions", "apply", "--change", change, "--json"];

  const fetchPayload = async (): Promise<ApplyPayload | string> => {
    const output = await run(args, { cwd: target.cwd, timeout: OPENSPEC_TIMEOUT_MS });
    if (output.missing) return `mate: ${output.stderr}`;
    if (output.code === null) return "mate: openspec instructions apply timed out.";
    if (output.code !== 0) {
      const detail = failureDetail(output.stdout, output.stderr);
      return `mate: openspec instructions apply failed (exit code ${output.code})${detail ? `: ${detail}` : ""}`;
    }
    return (
      parsePayload(output.stdout) ?? "mate: openspec instructions apply returned malformed JSON."
    );
  };

  const producer = (
    deps.producer ??
    (() => {
      const location = locateOpenSpec();
      return { openspec: "missing" in location ? null : (location.version ?? null) };
    })
  )();
  const identity: DigestIdentity = {
    producer,
    editContext: {
      change,
      cwd: await physical(target.cwd),
      companion: await physical(context.companionPath),
      repository: repoPath ? await physical(repoPath) : null,
    },
  };
  const secretPolicy = await (deps.loadSecretPolicy ?? defaultLoadSecretPolicy)(context);
  const allowedRoots = [context.companionPath, ...(repoPath ? [repoPath] : [])];

  const collected = await collect(fetchPayload, identity, { allowedRoots, secretPolicy });
  if (typeof collected === "string") return refuse(collected);
  const { payload, digest, limitation } = collected;

  if (since !== undefined && !isWellFormedDigest(since)) {
    emitErr("warning: --since is not a well-formed digest; sending the full context.");
  }
  const envelope = encodeApplyContext({
    payload,
    digest,
    limitation,
    ...(since !== undefined && isWellFormedDigest(since) ? { since } : {}),
  });
  if (envelope.mode === "full" && envelope.limitation) {
    emitErr(`warning: compact updates are unavailable: ${envelope.limitation}`);
  }
  emitOut(JSON.stringify(envelope));
}
