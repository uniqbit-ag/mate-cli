import { createHash } from "node:crypto";

/**
 * Version 1 of the compact apply transport: a stateless envelope around fresh
 * `openspec instructions apply --json` output. A full envelope carries the whole
 * upstream payload; a compact one carries only what a checkbox update changes,
 * valid against the full baseline whose digest it repeats.
 */
const APPLY_CONTEXT_PROTOCOL = "mate-apply-context";
const APPLY_CONTEXT_VERSION = 1;

export type ApplyPayload = Record<string, unknown>;

export interface TaskState {
  id: string;
  done: boolean;
}

export interface FullEnvelope {
  version: 1;
  mode: "full";
  /** Baseline for a later `--since`; null when this payload cannot be compacted against. */
  digest: string | null;
  payload: ApplyPayload;
  /** Why `digest` is null, e.g. an unreadable context file or ambiguous task location. */
  limitation?: string;
}

export interface CompactEnvelope {
  version: 1;
  mode: "compact";
  digest: string;
  state: unknown;
  progress: unknown;
  /** Every current task, in upstream order. */
  taskStates: TaskState[];
}

export type ApplyEnvelope = FullEnvelope | CompactEnvelope;

/** What the payload was produced by and resolved against; any change invalidates a baseline. */
export interface DigestIdentity {
  producer: Record<string, unknown>;
  editContext: Record<string, unknown>;
}

export interface ArtifactFingerprint {
  path: string;
  sha256: string;
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isWellFormedDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

/** JSON with object keys sorted at every level; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Tasks a compact update can describe: objects with a unique string `id` and boolean `done`. */
export function compactableTasks(
  payload: ApplyPayload,
): { ok: true; tasks: Record<string, unknown>[] } | { ok: false; reason: string } {
  if (typeof payload.state !== "string") return { ok: false, reason: "upstream state is missing" };
  if (!("progress" in payload)) return { ok: false, reason: "upstream progress is missing" };
  if (!Array.isArray(payload.tasks)) return { ok: false, reason: "upstream tasks are missing" };
  const seen = new Set<string>();
  for (const task of payload.tasks) {
    if (!isRecord(task) || typeof task.id !== "string" || typeof task.done !== "boolean") {
      return { ok: false, reason: "a task lacks a string id or boolean done" };
    }
    if (seen.has(task.id)) return { ok: false, reason: `duplicate task id ${task.id}` };
    seen.add(task.id);
  }
  return { ok: true, tasks: payload.tasks as Record<string, unknown>[] };
}

/** The payload minus what a compact update carries: top-level state/progress and task done. */
function staticView(payload: ApplyPayload): ApplyPayload {
  const { state: _state, progress: _progress, ...rest } = payload;
  if (Array.isArray(rest.tasks)) {
    rest.tasks = rest.tasks.map((task) => {
      if (!isRecord(task)) return task;
      const { done: _done, ...descriptor } = task;
      return descriptor;
    });
  }
  return rest;
}

export function computeDigest(
  identity: DigestIdentity,
  payload: ApplyPayload,
  fingerprints: ArtifactFingerprint[],
): string {
  const canonical = canonicalJson({
    protocol: APPLY_CONTEXT_PROTOCOL,
    version: APPLY_CONTEXT_VERSION,
    identity,
    payload: staticView(payload),
    fingerprints: [...fingerprints].sort((a, b) => a.path.localeCompare(b.path)),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function nonEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== false && value !== "";
}

/** Why fresh output must be sent in full whatever the baseline: warnings, prerequisites, a block. */
export function fullReason(payload: ApplyPayload): string | null {
  if (payload.state === "blocked") return "blocked";
  if (nonEmpty(payload.warnings)) return "warnings";
  if (nonEmpty(payload.missingArtifacts)) return "missing artifacts";
  return null;
}

export interface EncodeInput {
  payload: ApplyPayload;
  /** Null disables compaction; `limitation` says why. */
  digest: string | null;
  limitation?: string;
  since?: string;
}

export function encodeApplyContext(input: EncodeInput): ApplyEnvelope {
  const { payload, digest, limitation, since } = input;
  const full = (): FullEnvelope => ({
    version: 1,
    mode: "full",
    digest,
    payload,
    ...(digest === null && limitation ? { limitation } : {}),
  });
  if (digest === null || since !== digest || fullReason(payload) !== null) return full();
  const tasks = compactableTasks(payload);
  if (!tasks.ok) return full();
  return {
    version: 1,
    mode: "compact",
    digest,
    state: payload.state,
    progress: payload.progress,
    taskStates: tasks.tasks.map((task) => ({ id: task.id as string, done: task.done as boolean })),
  };
}

/**
 * The fresh upstream payload an envelope stands for. Throws when a compact
 * update does not belong to the baseline; callers then fetch a full envelope.
 */
export function reconstructPayload(baseline: FullEnvelope, update: ApplyEnvelope): ApplyPayload {
  if (update.mode === "full") return update.payload;
  if (baseline.digest === null || baseline.digest !== update.digest) {
    throw new Error("compact update does not match the baseline digest");
  }
  const baseTasks = baseline.payload.tasks;
  if (
    !Array.isArray(baseTasks) ||
    baseTasks.length !== update.taskStates.length ||
    baseTasks.some((task, index) => !isRecord(task) || task.id !== update.taskStates[index].id)
  ) {
    throw new Error("compact update tasks do not match the baseline tasks");
  }
  return {
    ...baseline.payload,
    state: update.state,
    progress: update.progress,
    tasks: baseTasks.map((task, index) => ({
      ...(task as Record<string, unknown>),
      done: update.taskStates[index].done,
    })),
  };
}
