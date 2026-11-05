import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import * as editor from "./editor";

afterEach(() => {
  mock.restore();
});

const tempRoots: string[] = [];

const managedSettings = { "git.detectWorktrees": true, "scm.alwaysShowRepositories": true };

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("editor helpers", () => {
  test("prefers cursor when TERM_PROGRAM is cursor", () => {
    expect(editor.getPreferredEditorCli({ TERM_PROGRAM: "cursor" })).toBe("cursor");
  });

  test("prefers cursor when bundle id matches Cursor", () => {
    expect(editor.getPreferredEditorCli({ __CFBundleIdentifier: "com.todesktop.cursor" })).toBe(
      "cursor",
    );
  });

  test("prefers cursor when Cursor trace env is present", () => {
    expect(editor.getPreferredEditorCli({ CURSOR_TRACE_ID: "trace-123" })).toBe("cursor");
  });

  test("defaults to code outside Cursor", () => {
    expect(editor.getPreferredEditorCli({ TERM_PROGRAM: "vscode" })).toBe("code");
  });

  test("detects vscode when only VSCODE_IPC_HOOK is present", () => {
    expect(editor.getPreferredEditorCli({ VSCODE_IPC_HOOK: "/tmp/vscode-ipc" })).toBe("code");
  });

  describe("openEditorWorkspace", () => {
    test("writes guidance and returns false when the editor CLI is unavailable", async () => {
      spyOn(editor, "resolveEditorBinary").mockReturnValue(null);
      const chunks: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        expect(await editor.openEditorWorkspace(["/tmp/companion"], "/tmp/repo-a", "code")).toBe(
          false,
        );
      } finally {
        process.stderr.write = originalWrite;
      }

      expect(chunks.join("")).toContain("code CLI not found on PATH");
    });

    test("falls back to the VS Code Insiders CLI when the standard CLI is unavailable", async () => {
      spyOn(editor, "resolveEditorBinary").mockImplementation((cli) =>
        cli === "code-insiders" ? "/usr/bin/code-insiders" : null,
      );
      const spawnCalls: Array<{ command: string; args: string[] }> = [];
      const spawnProcess = ((command: string, args: string[]) => {
        spawnCalls.push({ command, args });
        return {
          on: () => undefined,
          unref: () => undefined,
        } as unknown as EventEmitter & { unref(): void };
      }) as typeof spawn;
      const root = await makeTempDir("editor-inject-insiders-");
      const repoPath = path.join(root, "repo");
      const companionPath = path.join(root, "companion");
      await fs.mkdir(repoPath, { recursive: true });
      await fs.mkdir(companionPath, { recursive: true });

      expect(
        await editor.openEditorWorkspace([companionPath], repoPath, "code", spawnProcess),
      ).toBe(true);

      expect(spawnCalls).toEqual([
        {
          command: "/usr/bin/code-insiders",
          args: [editor.editorWorkspacePath(repoPath)],
        },
      ]);
    });

    test("writes the workspace document and opens it in the editor", async () => {
      spyOn(editor, "resolveEditorBinary").mockReturnValue("/usr/bin/code");
      const spawnCalls: Array<{ command: string; args: string[]; options: object }> = [];
      const spawnProcess = ((command: string, args: string[], options: object) => {
        spawnCalls.push({ command, args, options });
        return {
          on: () => undefined,
          unref: () => undefined,
        } as unknown as EventEmitter & { unref(): void };
      }) as typeof spawn;
      const root = await makeTempDir("editor-inject-");
      const repoPath = path.join(root, "repo");
      const companionPath = path.join(root, "companion");
      await fs.mkdir(repoPath, { recursive: true });
      await fs.mkdir(companionPath, { recursive: true });

      expect(
        await editor.openEditorWorkspace([companionPath], repoPath, "code", spawnProcess),
      ).toBe(true);

      const workspacePath = path.join(repoPath, `.${FRAMEWORK_NAME}`, "repo.mate.code-workspace");
      expect(editor.editorWorkspacePath(repoPath)).toBe(workspacePath);
      expect(JSON.parse(await fs.readFile(workspacePath, "utf8"))).toEqual({
        folders: [{ path: repoPath }, { path: companionPath }],
        settings: managedSettings,
      });
      expect(spawnCalls).toEqual([
        {
          command: "/usr/bin/code",
          args: [workspacePath],
          options: { stdio: "ignore", detached: true },
        },
      ]);
    });

    test("writes every companion folder after the repository", async () => {
      spyOn(editor, "resolveEditorBinary").mockReturnValue("/usr/bin/code");
      const spawnCalls: string[][] = [];
      const spawnProcess = ((command: string, args: string[]) => {
        spawnCalls.push([command, ...args]);
        return {
          on: () => undefined,
          unref: () => undefined,
        } as unknown as EventEmitter & { unref(): void };
      }) as typeof spawn;
      const root = await makeTempDir("editor-inject-many-");
      const repoPath = path.join(root, "repo");
      const companionB = path.join(root, "companion-b");
      const companionA = path.join(root, "companion-a");
      await Promise.all(
        [repoPath, companionB, companionA].map((dir) => fs.mkdir(dir, { recursive: true })),
      );

      expect(
        await editor.openEditorWorkspace([companionB, companionA], repoPath, "code", spawnProcess),
      ).toBe(true);

      expect(JSON.parse(await fs.readFile(editor.editorWorkspacePath(repoPath), "utf8"))).toEqual({
        folders: [{ path: repoPath }, { path: companionB }, { path: companionA }],
        settings: managedSettings,
      });
      expect(spawnCalls).toEqual([["/usr/bin/code", editor.editorWorkspacePath(repoPath)]]);
    });

    test("keeps a developer folder and opens the document again", async () => {
      spyOn(editor, "resolveEditorBinary").mockReturnValue("/usr/bin/code");
      const spawnCalls: string[][] = [];
      const spawnProcess = ((command: string, args: string[]) => {
        spawnCalls.push([command, ...args]);
        return {
          on: () => undefined,
          unref: () => undefined,
        } as unknown as EventEmitter & { unref(): void };
      }) as typeof spawn;
      const root = await makeTempDir("editor-open-again-");
      const repoPath = path.join(root, "repo");
      const companionPath = path.join(root, "companion");
      await fs.mkdir(repoPath, { recursive: true });
      await fs.mkdir(companionPath, { recursive: true });
      await editor.openEditorWorkspace([companionPath], repoPath, "code", spawnProcess);
      const workspacePath = editor.editorWorkspacePath(repoPath);
      const document = JSON.parse(await fs.readFile(workspacePath, "utf8"));
      document.folders.push({ path: "/acme/extra" });
      await fs.writeFile(workspacePath, JSON.stringify(document));

      expect(
        await editor.openEditorWorkspace([companionPath], repoPath, "code", spawnProcess),
      ).toBe(true);

      expect(await fs.readFile(workspacePath, "utf8")).toBe(JSON.stringify(document));
      expect(spawnCalls).toEqual([
        ["/usr/bin/code", workspacePath],
        ["/usr/bin/code", workspacePath],
      ]);
    });

    test("warns and spawns nothing when the workspace document is broken", async () => {
      spyOn(editor, "resolveEditorBinary").mockReturnValue("/usr/bin/code");
      const spawnProcess = mock(() => ({ on: () => undefined, unref: () => undefined }));
      const root = await makeTempDir("editor-open-broken-");
      const repoPath = path.join(root, "repo");
      const companionPath = path.join(root, "companion");
      await fs.mkdir(companionPath, { recursive: true });
      const workspacePath = editor.editorWorkspacePath(repoPath);
      await fs.mkdir(path.dirname(workspacePath), { recursive: true });
      await fs.writeFile(workspacePath, '{ "folders": [');
      const chunks: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        expect(
          await editor.openEditorWorkspace(
            [companionPath],
            repoPath,
            "code",
            spawnProcess as unknown as typeof spawn,
          ),
        ).toBe(false);
      } finally {
        process.stderr.write = originalWrite;
      }

      expect(chunks.join("")).toContain(`mate: warning: ${workspacePath}: invalid JSONC:`);
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(await fs.readFile(workspacePath, "utf8")).toBe('{ "folders": [');
    });
  });
});
