import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { defaultSecretPolicy } from "../../runtime/secret-patterns";
import { fingerprintArtifacts } from "./fingerprint";
import type { ApplyPayload } from "./protocol";

let root: string;
let changeDir: string;
let tasksFile: string;
let specFile: string;

const DESCRIPTIONS = ["1.1 Add the acme queue", "1.2 Cover the acme queue with tests"];

function tasksMarkdown(done: boolean[], prefix = ""): string {
  return [
    "# Tasks: acme-queue",
    prefix,
    "## acme",
    ...DESCRIPTIONS.map((text, index) => `- [${done[index] ? "x" : " "}] ${text}`),
    "",
  ].join("\n");
}

/** The upstream payload for the current `tasks.md`, as OpenSpec would parse it. */
function payloadFor(done: boolean[], lineOffset = 0): ApplyPayload {
  return {
    contextFiles: { specs: [specFile], tasks: [tasksFile] },
    tasks: DESCRIPTIONS.map((description, index) => ({
      id: String(index + 1),
      description,
      done: done[index],
      sourcePath: tasksFile,
      line: 4 + index + lineOffset,
    })),
  };
}

const options = () => ({ allowedRoots: [root], secretPolicy: defaultSecretPolicy() });

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "apply-context-")));
  changeDir = path.join(root, "openspec", "changes", "acme-queue");
  await fs.mkdir(path.join(changeDir, "specs"), { recursive: true });
  tasksFile = path.join(changeDir, "tasks.md");
  specFile = path.join(changeDir, "specs", "spec.md");
  await fs.writeFile(tasksFile, tasksMarkdown([false, false]));
  await fs.writeFile(specFile, "## Requirement: acme queue\n");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function prints(payload: ApplyPayload) {
  const result = await fingerprintArtifacts(payload, options());
  if (!result.ok) throw new Error(result.reason);
  return result.fingerprints;
}

describe("fingerprintArtifacts", () => {
  test("checking a task changes only normalized checkbox state, so fingerprints match", async () => {
    const before = await prints(payloadFor([false, false]));
    await fs.writeFile(tasksFile, tasksMarkdown([true, false]));
    expect(await prints(payloadFor([true, false]))).toEqual(before);
  });

  test("a spec edit at the same path changes the fingerprint", async () => {
    const before = await prints(payloadFor([false, false]));
    await fs.writeFile(specFile, "## Requirement: acme queue, revised\n");
    expect(await prints(payloadFor([false, false]))).not.toEqual(before);
  });

  test("task lines moved by an inserted line change the fingerprint", async () => {
    const before = await prints(payloadFor([false, false]));
    await fs.writeFile(tasksFile, tasksMarkdown([false, false], "\nA note.\n"));
    expect(await prints(payloadFor([false, false], 2))).not.toEqual(before);
  });

  test("task prose that no longer matches upstream disables compaction", async () => {
    await fs.writeFile(tasksFile, tasksMarkdown([false, false]).replace("Add the", "Build the"));
    const result = await fingerprintArtifacts(payloadFor([false, false]), options());
    expect(result).toEqual({ ok: false, reason: "task 1 does not match its source line 4" });
  });

  test("a checkbox state that differs from upstream disables compaction", async () => {
    await fs.writeFile(tasksFile, tasksMarkdown([true, false]));
    const result = await fingerprintArtifacts(payloadFor([false, false]), options());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("state differs");
  });

  test("two tasks at one source location are ambiguous", async () => {
    const payload = payloadFor([false, false]);
    (payload.tasks as { line: number }[])[1].line = 4;
    const result = await fingerprintArtifacts(payload, options());
    expect(!result.ok && result.reason).toContain("share the source location");
  });

  test("unreadable, outside-root, and secret files are never read", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "apply-outside-")));
    try {
      await fs.writeFile(path.join(outside, "spec.md"), "x");
      await fs.writeFile(path.join(changeDir, ".env"), "TOKEN=x");
      const cases: [string, string][] = [
        [path.join(changeDir, "missing.md"), "unreadable"],
        [path.join(outside, "spec.md"), "outside the companion"],
        [path.join(changeDir, ".env"), "secret file"],
        ["relative/spec.md", "not absolute"],
      ];
      for (const [file, reason] of cases) {
        const payload = { contextFiles: { specs: [file] } };
        let read = false;
        const result = await fingerprintArtifacts(payload, {
          ...options(),
          readFile: async (filePath) => {
            if (filePath.endsWith(".env")) read = true;
            return fs.readFile(filePath, "utf8");
          },
        });
        expect(!result.ok && result.reason).toContain(reason);
        expect(read).toBe(false);
      }
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test("a symlink escaping the allowed roots is refused", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "apply-outside-")));
    try {
      await fs.writeFile(path.join(outside, "spec.md"), "x");
      const link = path.join(changeDir, "linked.md");
      await fs.symlink(path.join(outside, "spec.md"), link);
      const result = await fingerprintArtifacts({ contextFiles: { specs: [link] } }, options());
      expect(!result.ok && result.reason).toContain("outside the companion");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test("an unsupported contextFiles shape disables compaction", async () => {
    const result = await fingerprintArtifacts({ contextFiles: ["x"] }, options());
    expect(result).toEqual({ ok: false, reason: "contextFiles has an unsupported shape" });
  });
});
