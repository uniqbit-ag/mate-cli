import fs from "node:fs/promises";
import path from "node:path";

import { resolveRepository } from "./repository";

interface WorkspaceUri {
  scheme: string;
  fsPath: string;
}

export interface WorkspaceState {
  repo: string | null;
  ready: boolean;
  canOpen: boolean;
  workspaceFile?: string;
}

export function managedWorkspacePath(repo: string): string {
  return path.join(repo, ".mate", `${path.basename(repo)}.mate.code-workspace`);
}

async function sameWorkspaceFile(actual: string, expected: string): Promise<boolean> {
  try {
    const [actualPath, expectedPath, stat] = await Promise.all([
      fs.realpath(actual),
      fs.realpath(expected),
      fs.stat(actual),
    ]);
    return stat.isFile() && actualPath === expectedPath;
  } catch {
    return false;
  }
}

export async function resolveWorkspaceState(
  folder: WorkspaceUri | undefined,
  workspaceFile: WorkspaceUri | undefined,
): Promise<WorkspaceState> {
  const repo = await resolveRepository(folder?.scheme === "file" ? folder.fsPath : undefined);
  const canOpen = Boolean(
    repo &&
    (!workspaceFile || workspaceFile.scheme === "file" || workspaceFile.scheme === "untitled"),
  );
  return {
    repo,
    canOpen,
    workspaceFile: workspaceFile ? `${workspaceFile.scheme}:${workspaceFile.fsPath}` : undefined,
    ready: Boolean(
      repo &&
      workspaceFile?.scheme === "file" &&
      (await sameWorkspaceFile(workspaceFile.fsPath, managedWorkspacePath(repo))),
    ),
  };
}

interface WorkspaceGateDeps {
  resolve(): Promise<WorkspaceState>;
  update(state: WorkspaceState): Promise<void>;
  prepare(repo: string): Promise<unknown>;
  open(workspacePath: string): Promise<void>;
  opening(value: boolean): Promise<void>;
}

export class WorkspaceGate {
  state: WorkspaceState = { repo: null, ready: false, canOpen: false };
  private generation = 0;
  private checking = false;
  private inFlight?: Promise<void>;

  constructor(private readonly deps: WorkspaceGateDeps) {}

  get ready(): boolean {
    return !this.checking && this.state.ready;
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    this.checking = true;
    try {
      const state = await this.deps.resolve();
      if (generation !== this.generation) return;
      this.state = state;
      this.checking = false;
      await this.deps.update(state);
    } finally {
      if (generation === this.generation) this.checking = false;
    }
  }

  open(): Promise<void> {
    this.inFlight ??= this.openOnce().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async openOnce(): Promise<void> {
    await this.refresh();
    const target = this.state;
    if (this.ready) return;
    if (this.checking || !target.repo || !target.canOpen) {
      throw new Error("Open a local Git repository before opening its Mate workspace.");
    }
    await this.deps.opening(true);
    try {
      const result = await this.deps.prepare(target.repo);
      const workspacePath =
        result && typeof result === "object" && "workspacePath" in result
          ? result.workspacePath
          : undefined;
      if (
        typeof workspacePath !== "string" ||
        !path.isAbsolute(workspacePath) ||
        !(await sameWorkspaceFile(workspacePath, managedWorkspacePath(target.repo)))
      ) {
        throw new Error("Mate returned an invalid workspace path. Update Mate, then try again.");
      }
      await this.refresh();
      if (
        this.checking ||
        this.state.repo !== target.repo ||
        this.state.workspaceFile !== target.workspaceFile ||
        !this.state.canOpen
      ) {
        throw new Error("The workspace changed while preparing it. Try Open workspace again.");
      }
      if (!this.ready) await this.deps.open(workspacePath);
    } finally {
      await this.deps.opening(false);
    }
  }
}
