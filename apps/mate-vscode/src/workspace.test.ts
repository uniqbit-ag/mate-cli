import { afterEach, describe, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  managedWorkspacePath,
  resolveWorkspaceState,
  WorkspaceGate,
  type WorkspaceState,
} from "./workspace";

const run = promisify(execFile);
const roots: string[] = [];
const uri = (fsPath: string, scheme = "file") => ({ fsPath, scheme });
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "acme-workspace-")));
  roots.push(root);
  const repo = path.join(root, "acme");
  await fs.mkdir(repo);
  await run("git", ["init", "--quiet", repo]);
  const workspacePath = managedWorkspacePath(repo);
  const prepare = mock(async () => {
    await fs.mkdir(path.dirname(workspacePath), { recursive: true });
    await fs.writeFile(workspacePath, "{}");
    return { workspacePath };
  });
  let state: WorkspaceState = { repo, ready: false, canOpen: true };
  const deps = {
    resolve: mock(async () => state),
    update: mock(async (_state: WorkspaceState) => {}),
    prepare,
    open: mock(async (_file: string) => {}),
    opening: mock(async (_opening: boolean) => {}),
  };
  return {
    root,
    repo,
    workspacePath,
    deps,
    setState: (next: WorkspaceState) => {
      state = next;
    },
  };
}

describe("managed workspace identity", () => {
  test("missing-file detection is read-only; only the expected saved file is ready", async () => {
    const { repo, root, workspacePath, deps } = await fixture();
    expect(await resolveWorkspaceState(uri(repo), undefined)).toMatchObject({
      repo,
      ready: false,
      canOpen: true,
    });
    expect(await fs.stat(workspacePath).catch(() => null)).toBeNull();
    await deps.prepare();
    expect((await resolveWorkspaceState(uri(repo), uri(workspacePath))).ready).toBe(true);
    const other = path.join(root, "acme.mate.code-workspace");
    await fs.writeFile(other, "{}");
    for (const file of [
      uri(other),
      uri(workspacePath, "untitled"),
      uri(workspacePath, "vscode-remote"),
    ]) {
      expect((await resolveWorkspaceState(uri(repo), file)).ready).toBe(false);
    }
    expect((await resolveWorkspaceState(uri(repo), uri(other, "vscode-remote"))).canOpen).toBe(
      false,
    );
    expect((await resolveWorkspaceState(undefined, undefined)).canOpen).toBe(false);
    expect((await resolveWorkspaceState(uri(repo, "vscode-remote"), undefined)).repo).toBeNull();
  });

  test("accepts a symlink to the same file, not a different checkout or a directory", async () => {
    const { root, repo, workspacePath, deps } = await fixture();
    await deps.prepare();
    const alias = path.join(root, "acme-alias.code-workspace");
    await fs.symlink(workspacePath, alias);
    expect((await resolveWorkspaceState(uri(repo), uri(alias))).ready).toBe(true);
    const other = path.join(root, "acme-other");
    await fs.mkdir(other);
    await run("git", ["init", "--quiet", other]);
    expect((await resolveWorkspaceState(uri(other), uri(workspacePath))).ready).toBe(false);
    await fs.unlink(workspacePath);
    await fs.mkdir(workspacePath);
    expect((await resolveWorkspaceState(uri(repo), uri(workspacePath))).ready).toBe(false);
  });
});

describe("workspace gate", () => {
  test("creates on explicit click only, shares repeated clicks, and waits for actual readiness", async () => {
    const { repo, workspacePath, deps } = await fixture();
    const gate = new WorkspaceGate(deps);
    await gate.refresh();
    expect(gate.ready).toBe(false);
    expect(deps.prepare).not.toHaveBeenCalled();
    const first = gate.open();
    expect(gate.open()).toBe(first);
    await first;
    expect(deps.prepare).toHaveBeenCalledTimes(1);
    expect(deps.prepare).toHaveBeenCalledWith(repo);
    expect(deps.open).toHaveBeenCalledTimes(1);
    expect(deps.open).toHaveBeenCalledWith(workspacePath);
    expect(deps.opening.mock.calls).toEqual([[true], [false]]);
    expect(gate.ready).toBe(false);
  });

  test("already-open invocation does not prepare or reopen", async () => {
    const { repo, deps, setState } = await fixture();
    setState({ repo, ready: true, canOpen: true });
    const gate = new WorkspaceGate(deps);
    await gate.open();
    expect(gate.ready).toBe(true);
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.open).not.toHaveBeenCalled();
  });

  test("ignores stale asynchronous detection", async () => {
    const { deps } = await fixture();
    let finish!: (state: WorkspaceState) => void;
    deps.resolve.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const gate = new WorkspaceGate(deps);
    const first = gate.refresh();
    await gate.refresh();
    finish({ repo: "/work/acme-other", ready: true, canOpen: true });
    await first;
    expect(gate.ready).toBe(false);
    expect(deps.update).toHaveBeenCalledTimes(1);
  });

  test.each([
    null,
    {},
    { workspacePath: "relative.code-workspace" },
    { workspacePath: "/work/acme-wrong" },
  ])("rejects invalid prepared paths: %j", async (result) => {
    const { deps } = await fixture();
    const gate = new WorkspaceGate({ ...deps, prepare: async () => result });
    await expect(gate.open()).rejects.toThrow("invalid workspace path");
    expect(deps.open).not.toHaveBeenCalled();
    expect(deps.opening).toHaveBeenLastCalledWith(false);
  });

  test("stays retryable after preparation and native-open failures", async () => {
    const { deps } = await fixture();
    deps.prepare.mockRejectedValueOnce(new Error("Mate unavailable"));
    deps.open.mockRejectedValueOnce(new Error("Open cancelled"));
    const gate = new WorkspaceGate(deps);
    await expect(gate.open()).rejects.toThrow("Mate unavailable");
    await expect(gate.open()).rejects.toThrow("Open cancelled");
    await gate.open();
    expect(deps.prepare).toHaveBeenCalledTimes(3);
    expect(deps.open).toHaveBeenCalledTimes(2);
    expect(gate.ready).toBe(false);
  });

  test("does not open after the current target changes during preparation", async () => {
    const { repo, deps, setState } = await fixture();
    const prepare = deps.prepare;
    const gate = new WorkspaceGate({
      ...deps,
      prepare: async () => {
        const result = await prepare();
        setState({
          repo,
          workspaceFile: "file:/work/acme-other.code-workspace",
          ready: false,
          canOpen: true,
        });
        return result;
      },
    });
    await expect(gate.open()).rejects.toThrow("workspace changed");
    expect(deps.open).not.toHaveBeenCalled();
  });

  test("unsupported context offers no implicit enrollment or preparation", async () => {
    const { deps, setState } = await fixture();
    setState({ repo: null, ready: false, canOpen: false });
    const gate = new WorkspaceGate(deps);
    await expect(gate.open()).rejects.toThrow("local Git repository");
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.open).not.toHaveBeenCalled();
  });
});
