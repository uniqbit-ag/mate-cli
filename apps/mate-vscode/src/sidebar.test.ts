import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SectionItem } from "./section";
import * as mate from "./mate";

const providers = new Map<string, { getChildren(): Promise<SectionItem[]> }>();
const handlers = new Map<string, (...args: unknown[]) => unknown>();
const commands: unknown[][] = [];
const contexts = new Map<string, unknown>();
const workspace = {
  workspaceFolders: [] as { uri: { fsPath: string; scheme: string } }[],
  workspaceFile: undefined as { fsPath: string; scheme: string } | undefined,
  createFileSystemWatcher: () => ({
    onDidChange: () => ({ dispose() {} }),
    onDidCreate: () => ({ dispose() {} }),
    dispose() {},
  }),
  onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
};

mock.module("vscode", () => ({
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  TreeItem: class {
    constructor(
      public label: string,
      public collapsibleState: number,
    ) {}
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {},
  ThemeColor: class {},
  Uri: { file: (fsPath: string) => ({ fsPath, scheme: "file" }) },
  RelativePattern: class {},
  workspace,
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(id, handler);
      return { dispose: () => handlers.delete(id) };
    },
    executeCommand: async (...args: unknown[]) => {
      commands.push(args);
      if (args[0] === "setContext") contexts.set(String(args[1]), args[2]);
    },
  },
  window: {
    terminals: [],
    onDidOpenTerminal: () => ({ dispose() {} }),
    onDidCloseTerminal: () => ({ dispose() {} }),
    showErrorMessage: mock(async (_message: string) => undefined),
    createTreeView: (
      id: string,
      options: { treeDataProvider: { getChildren(): Promise<SectionItem[]> } },
    ) => {
      providers.set(id, options.treeDataProvider);
      return {
        visible: false,
        onDidChangeVisibility: () => ({ dispose() {} }),
        dispose() {},
      };
    },
  },
}));

const { worksetItem, activate } = await import("./extension");
const { Section } = await import("./section");
const { readOpenChanges } = await import("./changes");
const { worksetsOf } = await import("./groups");
import type { OpenChange } from "./changes";
import type { Session } from "./sessions";

afterAll(() => mock.restore());

const change = (name: string, done = 0, total = 0): OpenChange => ({
  name,
  done,
  total,
  deliveryBranch: "workset/acme",
});

const session = (id: string, lastSeenAt: string, branch = "workset/acme"): Session => ({
  id,
  runtime: "opencode",
  cwd: "/work/acme",
  branch,
  state: "parked",
  startedAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt,
});

describe("Open changes items", () => {
  test("combines tasks and retains session counts and the latest-session payload", () => {
    const [workset] = worksetsOf([change("acme-queue", 3, 5), change("acme-retry", 2, 7)]);
    const latest = session("acme-latest", "2026-01-03T00:00:00.000Z");
    const item = worksetItem(workset!, [
      session("acme-old", "2026-01-02T00:00:00.000Z"),
      latest,
      session("acme-other", "2026-01-04T00:00:00.000Z", "main"),
    ]);
    expect(item.description).toBe("5/12 tasks · 2 sessions");
    expect(item.contextValue).toBe("workset.sessions");
    expect(item.data).toBe(latest);
    expect(item.children?.map((child) => child.description)).toEqual(["3/5", "2/7"]);
    expect(worksetItem(workset!, [latest]).description).toBe("5/12 tasks · 1 session");
  });

  test("shows zero tasks and standalone changes without a Workset description", () => {
    const [empty] = worksetsOf([change("acme-empty")]);
    const [solo] = worksetsOf([{ name: "acme-solo", done: 1, total: 2 }]);
    expect(worksetItem(empty!, []).description).toBe("0/0 tasks");
    const item = worksetItem(solo!, []);
    expect(item.description).toBe("1/2 tasks");
    expect(item.collapsed).toBe(true);
    expect(item.contextValue).toBe("workset");
    expect(item.data).toBeUndefined();
  });

  test("defaults to collapsed and preserves identity through refresh and progress changes", async () => {
    const changes = [change("acme-queue", 3, 5)];
    const [workset] = worksetsOf(changes);
    const section = new Section("acme.openChanges", async () => ({
      items: [worksetItem(workset!, [])],
    }));
    try {
      const [first] = await section.getChildren();
      const tree = section.getTreeItem(first!);
      expect(tree.collapsibleState).toBe(1);
      expect(tree.id).toBe("workset:workset/acme");
      changes[0]!.done = 4;
      workset!.label = "acme renamed";
      section.refresh();
      const [refreshed] = await section.getChildren();
      const updated = section.getTreeItem(refreshed!);
      expect(updated.id).toBe(tree.id);
      expect(updated.description).toBe("4/5 tasks");
      expect(section.getTreeItem({ label: "acme", children: [] }).collapsibleState).toBe(2);
      expect(
        section.getTreeItem({ label: "Older", children: [], collapsed: true }).collapsibleState,
      ).toBe(1);
    } finally {
      section.dispose();
    }
  });
});

describe("change navigation", () => {
  let repo: string | undefined;
  afterEach(async () => {
    if (repo) await fs.rm(repo, { recursive: true, force: true });
    repo = undefined;
  });

  test("opens minimal tasks, prefers proposals, and counts missing or empty tasks as zero", async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "acme-sidebar-"));
    const root = path.join(repo, ".mate/companion/openspec/changes");
    for (const name of ["acme-minimal", "acme-full", "acme-empty", "acme-missing", "archive"]) {
      await fs.mkdir(path.join(root, name), { recursive: true });
    }
    await fs.writeFile(path.join(root, "acme-minimal/.openspec.yaml"), "schema: mate-minimal\n");
    await fs.writeFile(path.join(root, "acme-minimal/tasks.md"), "- [x] 1.1 acme\n");
    await fs.writeFile(path.join(root, "acme-full/proposal.md"), "# Acme\n");
    await fs.writeFile(path.join(root, "acme-full/tasks.md"), "- [ ] 1.1 acme\n");
    await fs.writeFile(path.join(root, "acme-empty/tasks.md"), "# Acme\n");
    const result = await readOpenChanges(repo);
    if (!result.linked) throw new Error("Fixture must be linked");
    const items = worksetsOf(result.changes).map((workset) => worksetItem(workset, []));
    expect(items.map((item) => [item.label, item.description])).toEqual([
      ["acme-empty", "0/0 tasks"],
      ["acme-full", "0/1 tasks"],
      ["acme-minimal", "1/1 tasks"],
      ["acme-missing", "0/0 tasks"],
    ]);
    const commandFor = (label: string) =>
      items.find((item) => item.label === label)?.children?.[0]?.command;
    expect(commandFor("acme-minimal")).toEqual({
      command: "vscode.open",
      title: "Open",
      arguments: [{ fsPath: path.join(root, "acme-minimal/tasks.md"), scheme: "file" }],
    });
    expect(commandFor("acme-full")?.arguments).toEqual([
      { fsPath: path.join(root, "acme-full/proposal.md"), scheme: "file" },
    ]);
    expect(commandFor("acme-missing")).toBeUndefined();
  });
});

describe("workspace gate wiring", () => {
  let root: string | undefined;
  const subscriptions: { dispose(): unknown }[] = [];
  afterEach(async () => {
    for (const subscription of subscriptions.splice(0)) subscription.dispose();
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
    workspace.workspaceFolders = [];
    workspace.workspaceFile = undefined;
    providers.clear();
    handlers.clear();
    commands.length = 0;
    contexts.clear();
    mock.restore();
  });

  test("gates sources, prepares on click, and opens only the managed workspace in this window", async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "acme-editor-")));
    const repo = path.join(root, "acme");
    await fs.mkdir(repo);
    await promisify(execFile)("git", ["init", "--quiet", repo]);
    const file = path.join(repo, ".mate/acme.mate.code-workspace");
    workspace.workspaceFolders = [{ uri: { fsPath: repo, scheme: "file" } }];
    const list = mock(async () => []);
    const pending = mock(async () => ({ pending: [] }));
    const { spyOn } = await import("bun:test");
    spyOn(mate, "listSessions").mockImplementation(list);
    spyOn(mate, "pendingArtifacts").mockImplementation(pending);
    const prepare = spyOn(mate, "prepareWorkspace").mockImplementation(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "{}");
      return { workspacePath: file } as never;
    });
    activate({ subscriptions } as never);
    await handlers.get("mate.refresh")!();
    for (const id of [
      "mate.sessions",
      "mate.worktrees",
      "mate.openChanges",
      "mate.readyToPublish",
    ]) {
      expect(await providers.get(id)!.getChildren()).toEqual([]);
    }
    expect(contexts.get("mate.workspaceReady")).toBe(false);
    expect(contexts.get("mate.workspaceCanOpen")).toBe(true);
    expect(await fs.stat(file).catch(() => null)).toBeNull();
    expect(list).not.toHaveBeenCalled();
    expect(pending).not.toHaveBeenCalled();
    await handlers.get("mate.openWorkspace")!();
    expect(prepare).toHaveBeenCalledWith(repo);
    expect(commands.filter((command) => command[0] !== "setContext")).toEqual([
      ["vscode.openFolder", { fsPath: file, scheme: "file" }, { forceReuseWindow: true }],
    ]);
    expect(contexts.get("mate.workspaceReady")).toBe(false);
    workspace.workspaceFile = { fsPath: file, scheme: "file" };
    await handlers.get("mate.refresh")!();
    expect(contexts.get("mate.workspaceReady")).toBe(true);
    await providers.get("mate.sessions")!.getChildren();
    expect(list).toHaveBeenCalledTimes(1);
  });

  test("contributes one native welcome view instead of four repeated gates", async () => {
    const manifest = await Bun.file(path.join(import.meta.dir, "../package.json")).json();
    const views = manifest.contributes.views.mate;
    expect(
      views
        .filter((view: { when: string }) => view.when === "!mate.workspaceReady")
        .map((view: { id: string }) => view.id),
    ).toEqual(["mate.workspace"]);
    expect(
      views.filter((view: { when: string }) => view.when === "mate.workspaceReady"),
    ).toHaveLength(4);
    expect(
      manifest.contributes.viewsWelcome.filter((view: { contents: string }) =>
        view.contents.includes("command:mate.openWorkspace"),
      ),
    ).toHaveLength(1);
  });
});
