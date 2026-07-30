import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import matePiExtension from "./mate-extension";

const previousEnvironment = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in previousEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, previousEnvironment);
});

function handlers(): Map<string, (...args: any[]) => unknown> {
  const registered = new Map<string, (...args: any[]) => unknown>();
  matePiExtension({
    on(event, handler) {
      registered.set(event, handler);
    },
  });
  return registered;
}

describe("bundled Mate Pi extension", () => {
  test("appends Mate guidance at agent start", () => {
    process.env.MATE_PI_GUIDANCE = "Mate guidance";
    const result = handlers().get("before_agent_start")?.({ systemPrompt: "Pi prompt" });
    expect(result).toEqual({ systemPrompt: "Pi prompt\n\nMate guidance" });
  });

  test("allows relative and absolute writes inside managed repositories", () => {
    process.env.MATE_REPO_PATH = "/acme/repo";
    process.env.MATE_ARTIFACT_PATH = "/acme/companion";
    const toolCall = handlers().get("tool_call");

    expect(toolCall?.({ toolName: "write", input: { path: "src/index.ts" } })).toBeUndefined();
    expect(
      toolCall?.({ toolName: "edit", input: { file_path: "/acme/repo/src/index.ts" } }),
    ).toBeUndefined();
    expect(
      toolCall?.({ toolName: "write", input: { filePath: "/acme/companion/notes.md" } }),
    ).toBeUndefined();
  });

  test.each(["../outside.txt", "/acme/repo/../outside.txt"])(
    "blocks writes outside managed repositories through %s",
    (candidate) => {
      process.env.MATE_REPO_PATH = "/acme/repo";
      process.env.MATE_ARTIFACT_PATH = "/acme/companion";
      const result = handlers().get("tool_call")?.({
        toolName: "write",
        input: { path: candidate },
      });
      expect(result).toEqual({
        block: true,
        reason: `Mate blocked a write outside the linked repository and companion: ${candidate}`,
      });
    },
  );

  test.each(["MATE_REPO_PATH", "MATE_ARTIFACT_PATH"])(
    "blocks writes when %s is missing",
    (missingRoot) => {
      process.env.MATE_REPO_PATH = "/acme/repo";
      process.env.MATE_ARTIFACT_PATH = "/acme/companion";
      delete process.env[missingRoot];
      const result = handlers().get("tool_call")?.({
        toolName: "write",
        input: { path: "src/index.ts" },
      });
      expect(result).toEqual({
        block: true,
        reason: "Mate blocked a write outside the linked repository and companion: src/index.ts",
      });
    },
  );

  test("blocks writes through a symlink outside the working repository", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "acme-pi-extension-"));
    const repoPath = path.join(root, "repo");
    const artifactPath = path.join(root, "companion");
    const outsidePath = path.join(root, "outside");

    try {
      await Promise.all([fs.mkdir(repoPath), fs.mkdir(artifactPath), fs.mkdir(outsidePath)]);
      await fs.symlink(outsidePath, path.join(repoPath, "link"));
      process.env.MATE_REPO_PATH = repoPath;
      process.env.MATE_ARTIFACT_PATH = artifactPath;

      const result = handlers().get("tool_call")?.({
        toolName: "write",
        input: { path: "link/new-file.txt" },
      });
      expect(result).toEqual({
        block: true,
        reason:
          "Mate blocked a write outside the linked repository and companion: link/new-file.txt",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
