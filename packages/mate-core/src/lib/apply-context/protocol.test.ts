import { describe, expect, test } from "bun:test";

import {
  canonicalJson,
  computeDigest,
  encodeApplyContext,
  isWellFormedDigest,
  reconstructPayload,
  type ApplyPayload,
  type ArtifactFingerprint,
  type DigestIdentity,
  type FullEnvelope,
} from "./protocol";

const TASKS = 18;
const TASKS_FILE = "/companion/openspec/changes/acme-queue/tasks.md";

/** A sanitized 18-task apply payload shaped like `openspec instructions apply --json`. */
function payload(done = 0, extra: ApplyPayload = {}): ApplyPayload {
  const tasks = Array.from({ length: TASKS }, (_, index) => ({
    id: String(index + 1),
    description: `${Math.floor(index / 6) + 1}.${(index % 6) + 1} Add the acme queue step ${index + 1}: wire the handler, cover it with a focused test, and keep the existing retry and timeout behaviour unchanged`,
    done: index < done,
    sourcePath: TASKS_FILE,
    line: 20 + index,
  }));
  return {
    changeName: "acme-queue",
    changeDir: "/companion/openspec/changes/acme-queue",
    schemaName: "mate-v1",
    contextFiles: {
      proposal: ["/companion/openspec/changes/acme-queue/proposal.md"],
      specs: ["/companion/openspec/changes/acme-queue/specs/acme-queue/spec.md"],
      design: ["/companion/openspec/changes/acme-queue/design.md"],
      tasks: [TASKS_FILE],
    },
    progress: { total: TASKS, complete: done, remaining: TASKS - done },
    tasks,
    taskTrackingConfigured: true,
    state: done === TASKS ? "all_done" : "ready",
    instruction:
      "Read context files and work through pending tasks only within the proposal's affected Areas. Mark complete as you go.\nPause if you hit blockers or need clarification.\nBefore reporting the change complete, follow the verification rules in `openspec/mate-conventions.yaml`.",
    root: { path: "/companion", source: "nearest" },
    ...extra,
  };
}

const identity: DigestIdentity = {
  producer: { openspec: "1.15.0" },
  editContext: {
    change: "acme-queue",
    cwd: "/companion",
    companion: "/companion",
    repository: null,
  },
};
const fingerprints: ArtifactFingerprint[] = [{ path: TASKS_FILE, sha256: "a".repeat(64) }];
const digestOf = (value: ApplyPayload, id = identity, prints = fingerprints) =>
  computeDigest(id, value, prints);

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

describe("apply-context protocol", () => {
  test("canonical JSON sorts keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }, 1] })).toBe('{"a":[{"c":3,"d":2},1],"b":1}');
  });

  test("a full envelope keeps every upstream field and a well-formed digest", () => {
    const fresh = payload(0, { futureField: { nested: true } });
    const envelope = encodeApplyContext({ payload: fresh, digest: digestOf(fresh) });
    expect(envelope.mode).toBe("full");
    expect(isWellFormedDigest(envelope.digest)).toBe(true);
    expect((envelope as FullEnvelope).payload).toEqual(fresh);
  });

  test("checkbox-only changes keep the digest; a matching baseline yields a compact update", () => {
    const base = payload(0);
    const next = payload(1);
    expect(digestOf(next)).toBe(digestOf(base));
    const update = encodeApplyContext({
      payload: next,
      digest: digestOf(next),
      since: digestOf(base),
    });
    expect(update).toEqual({
      version: 1,
      mode: "compact",
      digest: digestOf(base),
      state: "ready",
      progress: { total: TASKS, complete: 1, remaining: TASKS - 1 },
      taskStates: next.tasks.map((task: { id: string; done: boolean }) => ({
        id: task.id,
        done: task.done,
      })),
    });
  });

  test("absent, malformed, or mismatched baselines produce full envelopes", () => {
    const fresh = payload(1);
    const digest = digestOf(fresh);
    for (const since of [undefined, "nope", `sha256:${"0".repeat(64)}`]) {
      expect(encodeApplyContext({ payload: fresh, digest, since }).mode).toBe("full");
    }
  });

  test("warnings, missing artifacts, and a blocked state force a full envelope", () => {
    for (const extra of [
      { warnings: ["acme-base is not implemented"] },
      { missingArtifacts: ["design"] },
      { state: "blocked" },
    ]) {
      const fresh = payload(1, extra);
      const digest = digestOf(fresh);
      expect(encodeApplyContext({ payload: fresh, digest, since: digest }).mode).toBe("full");
    }
  });

  test("a ready-to-all_done transition can be compact", () => {
    const base = payload(TASKS - 1);
    const done = payload(TASKS);
    const update = encodeApplyContext({
      payload: done,
      digest: digestOf(done),
      since: digestOf(base),
    });
    expect(update.mode).toBe("compact");
    expect(update.mode === "compact" && update.state).toBe("all_done");
  });

  test("structural, static, identity, and fingerprint changes all change the digest", () => {
    const base = payload(0);
    const variants: ApplyPayload[] = [];
    const clone = () =>
      structuredClone(base) as ApplyPayload & { tasks: Record<string, unknown>[] };
    let changed = clone();
    changed.tasks.push({ ...changed.tasks[0], id: "19", line: 99 });
    variants.push(changed);
    changed = clone();
    changed.tasks.pop();
    variants.push(changed);
    changed = clone();
    changed.tasks.reverse();
    variants.push(changed);
    changed = clone();
    changed.tasks[3].description = "1.4 Renamed acme step";
    variants.push(changed);
    changed = clone();
    changed.tasks[3].line = 77;
    variants.push(changed);
    changed = clone();
    changed.tasks[3].hint = "unknown task field";
    variants.push(changed);
    variants.push({ ...clone(), futureField: 1 });
    variants.push({ ...clone(), instruction: "changed guidance" });
    variants.push({ ...clone(), schemaName: "mate-minimal" });
    variants.push({ ...clone(), root: { path: "/renamed", source: "nearest" } });
    const digests = new Set(variants.map((variant) => digestOf(variant)));
    digests.add(digestOf(base));
    expect(digests.size).toBe(variants.length + 1);
    expect(digestOf(base, { ...identity, producer: { openspec: "1.16.0" } })).not.toBe(
      digestOf(base),
    );
    expect(
      digestOf(base, { ...identity, editContext: { ...identity.editContext, cwd: "/acme" } }),
    ).not.toBe(digestOf(base));
    expect(digestOf(base, identity, [{ path: TASKS_FILE, sha256: "b".repeat(64) }])).not.toBe(
      digestOf(base),
    );
  });

  test("replaying a full baseline plus compact updates reconstructs every fresh payload", () => {
    const baselinePayload = payload(0);
    const baseline = encodeApplyContext({
      payload: baselinePayload,
      digest: digestOf(baselinePayload),
    }) as FullEnvelope;
    for (let done = 1; done <= TASKS; done++) {
      const fresh = payload(done);
      const update = encodeApplyContext({
        payload: fresh,
        digest: digestOf(fresh),
        since: baseline.digest ?? undefined,
      });
      expect(update.mode).toBe("compact");
      expect(reconstructPayload(baseline, update)).toEqual(fresh);
    }
  });

  test("reconstruction refuses a compact update from another baseline", () => {
    const base = payload(0);
    const baseline = encodeApplyContext({ payload: base, digest: digestOf(base) }) as FullEnvelope;
    const other = { ...baseline, digest: `sha256:${"1".repeat(64)}` };
    const update = encodeApplyContext({
      payload: payload(1),
      digest: digestOf(base),
      since: digestOf(base),
    });
    expect(() => reconstructPayload(other, update)).toThrow("baseline digest");
  });

  test("a compact update is at least 50% smaller than the full response for 18 tasks", () => {
    const base = payload(0);
    const baseline = encodeApplyContext({ payload: base, digest: digestOf(base) });
    let fullSequence = bytes(baseline);
    let compactSequence = bytes(baseline);
    for (let done = 1; done <= TASKS; done++) {
      const fresh = payload(done);
      const full = encodeApplyContext({ payload: fresh, digest: digestOf(fresh) });
      const compact = encodeApplyContext({
        payload: fresh,
        digest: digestOf(fresh),
        since: digestOf(base),
      });
      expect(bytes(compact)).toBeLessThanOrEqual(bytes(full) * 0.5);
      fullSequence += bytes(full);
      compactSequence += bytes(compact);
    }
    expect(compactSequence).toBeLessThanOrEqual(fullSequence * 0.5);
  });
});
