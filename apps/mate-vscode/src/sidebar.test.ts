import { afterAll, afterEach, describe, expect, jest, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SectionItem } from "./section";
import * as mate from "./mate";

type Provider = {
  getChildren(): Promise<SectionItem[]>;
  onDidChangeTreeData?: (listener: () => void) => unknown;
  loading?: Promise<void>;
};
const providers = new Map<string, Provider>();
/** Tree views by id; a visible one loads when its provider fires, as VS Code does. */
const views = new Map<string, { visible: boolean; loads: number }>();
/** Listeners the extension registered, called by tests to simulate VS Code events. */
const listeners = {
  windowState: [] as ((state: { focused: boolean }) => void)[],
  configuration: [] as ((event: { affectsConfiguration(key: string): boolean }) => void)[],
};
const windowState = { focused: true };
const settings = new Map<string, unknown>();
const handlers = new Map<string, (...args: unknown[]) => unknown>();
const commands: unknown[][] = [];
const contexts = new Map<string, unknown>();
/** Quick pick titles shown, and the label the next pick answers with (undefined dismisses). */
const picks: string[] = [];
let pickLabel: string | undefined;
const terminals: { cwd: string; sent: string[] }[] = [];
const workspace = {
  workspaceFolders: [] as { uri: { fsPath: string; scheme: string } }[],
  workspaceFile: undefined as { fsPath: string; scheme: string } | undefined,
  createFileSystemWatcher: () => ({
    onDidChange: () => ({ dispose() {} }),
    onDidCreate: () => ({ dispose() {} }),
    dispose() {},
  }),
  onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
  getConfiguration: (section: string) => ({
    get: (key: string) => settings.get(`${section}.${key}`),
  }),
  onDidChangeConfiguration: (
    listener: (event: { affectsConfiguration(key: string): boolean }) => void,
  ) => {
    listeners.configuration.push(listener);
    return { dispose() {} };
  },
};

mock.module("vscode", () => ({
  EventEmitter: class {
    private readonly listeners = new Set<(value: unknown) => void>();
    event = (listener: (value: unknown) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value?: unknown) {
      for (const listener of this.listeners) listener(value);
    }
    dispose() {
      this.listeners.clear();
    }
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
    state: windowState,
    onDidChangeWindowState: (listener: (state: { focused: boolean }) => void) => {
      listeners.windowState.push(listener);
      return { dispose() {} };
    },
    terminals: [],
    onDidOpenTerminal: () => ({ dispose() {} }),
    onDidCloseTerminal: () => ({ dispose() {} }),
    showErrorMessage: mock(async (_message: string) => undefined),
    showInformationMessage: async () => undefined,
    showQuickPick: async (
      items: { label: string }[],
      options: { placeHolder: string },
    ): Promise<{ label: string } | undefined> => {
      picks.push(options.placeHolder);
      return items.find((item) => item.label === pickLabel);
    },
    createTerminal: (options: { cwd: string }) => {
      const terminal = { cwd: options.cwd, sent: [] as string[] };
      terminals.push(terminal);
      return { show() {}, sendText: (text: string) => terminal.sent.push(text) };
    },
    createTreeView: (id: string, options: { treeDataProvider: Provider }) => {
      const provider = options.treeDataProvider;
      providers.set(id, provider);
      const view = {
        visible: false,
        loads: 0,
        onDidChangeVisibility: () => ({ dispose() {} }),
        dispose() {},
      };
      views.set(id, view);
      provider.onDidChangeTreeData?.(() => {
        if (!view.visible) return;
        view.loads++;
        void provider.getChildren();
      });
      return view;
    },
  },
}));

const { worksetItem, activate } = await import("./extension");
const { Section } = await import("./section");
const { readOpenChanges } = await import("./changes");
const { worksetsOf } = await import("./groups");
import type { OpenChange } from "./changes";
import type { Session } from "./sessions";
import { umbrellaFixture } from "./umbrella.fixture";

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
    views.clear();
    listeners.windowState.length = 0;
    listeners.configuration.length = 0;
    windowState.focused = true;
    settings.clear();
    jest.useRealTimers();
    handlers.clear();
    commands.length = 0;
    contexts.clear();
    picks.length = 0;
    pickLabel = undefined;
    terminals.length = 0;
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
      "mate.readyToArchive",
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

  /** A repository with its managed workspace open, so every section loads. */
  async function openRepository(sessionsOf: (repo: string) => Session[] = () => []) {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "acme-editor-")));
    const repo = path.join(root, "acme");
    await fs.mkdir(repo);
    await promisify(execFile)("git", ["init", "--quiet", repo]);
    const file = path.join(repo, ".mate/acme.mate.code-workspace");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{}");
    workspace.workspaceFolders = [{ uri: { fsPath: repo, scheme: "file" } }];
    workspace.workspaceFile = { fsPath: file, scheme: "file" };
    const { spyOn } = await import("bun:test");
    spyOn(mate, "listSessions").mockImplementation(async () => sessionsOf(repo));
    spyOn(mate, "pendingArtifacts").mockImplementation(async () => ({ pending: [] }));
    activate({ subscriptions } as never);
    await handlers.get("mate.refresh")!();
    expect(contexts.get("mate.workspaceReady")).toBe(true);
    return repo;
  }

  const SECTIONS = [
    "mate.sessions",
    "mate.worktrees",
    "mate.openChanges",
    "mate.readyToArchive",
    "mate.readyToPublish",
  ];

  /** Shows `ids`, hides the other sections, and resets load counts. */
  function show(...ids: string[]) {
    for (const id of SECTIONS) {
      Object.assign(views.get(id)!, { visible: ids.includes(id), loads: 0 });
    }
  }

  const loads = () => Object.fromEntries(SECTIONS.map((id) => [id, views.get(id)!.loads]));

  /** Waits for running loads, then passes the 3 s gap and the view reuse window. */
  async function settle() {
    await Promise.all([...providers.values()].map((provider) => provider.loading));
    jest.advanceTimersByTime(3_000);
  }

  const focus = (focused: boolean) => {
    windowState.focused = focused;
    for (const listener of listeners.windowState) listener({ focused });
  };

  const configureInterval = (seconds: number) => {
    settings.set("mate.autoRefreshInterval", seconds);
    for (const listener of listeners.configuration) {
      listener({ affectsConfiguration: (key) => key === "mate.autoRefreshInterval" });
    }
  };

  test("reloads visible sections every interval while focused, and on focus", async () => {
    jest.useFakeTimers();
    await openRepository();
    show("mate.worktrees", "mate.readyToPublish");
    jest.advanceTimersByTime(29_999);
    expect(loads()["mate.worktrees"]).toBe(0);
    jest.advanceTimersByTime(1);
    expect(loads()).toEqual({
      "mate.sessions": 0,
      "mate.worktrees": 1,
      "mate.openChanges": 0,
      "mate.readyToArchive": 0,
      "mate.readyToPublish": 1,
    });

    // A tick while a load runs starts none.
    const blocked = Promise.withResolvers<{ pending: never[] }>();
    (mate.pendingArtifacts as unknown as ReturnType<typeof mock>).mockImplementation(
      () => blocked.promise,
    );
    await settle();
    show("mate.readyToPublish");
    jest.advanceTimersByTime(30_000);
    expect(loads()["mate.readyToPublish"]).toBe(1);
    jest.advanceTimersByTime(30_000);
    expect(loads()["mate.readyToPublish"]).toBe(1);
    blocked.resolve({ pending: [] });
    await settle();

    show("mate.worktrees");
    focus(false);
    jest.advanceTimersByTime(60_000);
    expect(loads()["mate.worktrees"]).toBe(0);
    focus(true);
    expect(loads()["mate.worktrees"]).toBe(1);
    // Focus right after a reload does nothing.
    focus(false);
    focus(true);
    expect(loads()["mate.worktrees"]).toBe(1);
  });

  test("applies a changed interval without a window reload, and 0 keeps focus reloads", async () => {
    jest.useFakeTimers();
    await openRepository();
    show("mate.worktrees");
    configureInterval(60);
    jest.advanceTimersByTime(30_000);
    expect(loads()["mate.worktrees"]).toBe(0);
    jest.advanceTimersByTime(30_000);
    expect(loads()["mate.worktrees"]).toBe(1);
    await settle();

    configureInterval(0);
    show("mate.worktrees");
    jest.advanceTimersByTime(600_000);
    expect(loads()["mate.worktrees"]).toBe(0);
    focus(false);
    focus(true);
    expect(loads()["mate.worktrees"]).toBe(1);
  });

  test("keeps Sessions group ids across reloads, so collapsed groups stay collapsed", async () => {
    jest.useFakeTimers({ now: new Date("2026-03-10T00:00:00.000Z") });
    await openRepository((cwd) => [
      { ...session("acme-recent", "2026-03-09T00:00:00.000Z", "feature/acme"), cwd },
      { ...session("acme-old", "2026-01-01T00:00:00.000Z", "feature/acme-old"), cwd },
    ]);
    const provider = providers.get("mate.sessions") as unknown as InstanceType<typeof Section>;
    const ids = async () =>
      (await provider.getChildren()).map((group) => provider.getTreeItem(group).id);
    const first = await ids();
    expect(first).toEqual(["sessions:b:feature/acme", "sessions:older"]);
    show("mate.sessions");
    await settle();
    jest.advanceTimersByTime(30_000);
    expect(loads()["mate.sessions"]).toBe(1);
    await settle();
    expect(await ids()).toEqual(first);
  });

  test("an automatic reload runs only local commands", async () => {
    jest.useFakeTimers();
    const bin = await fs.mkdtemp(path.join(os.tmpdir(), "acme-git-"));
    const log = path.join(bin, "git.log");
    // Logs each subcommand, then runs the real Git.
    await fs.writeFile(
      path.join(bin, "git"),
      `#!/bin/sh\nprintf '%s\\n' "$1" >> '${log}'\nexec '${Bun.which("git")}' "$@"\n`,
      { mode: 0o755 },
    );
    const originalPath = process.env.PATH;
    try {
      await openRepository();
      const { spyOn } = await import("bun:test");
      const others = (
        [
          "addSession",
          "removeSession",
          "stopOpenCode",
          "stopClaude",
          "claudeAgents",
          "claudeSupportsBackground",
          "startClaudeBackground",
          "prepareWorkspace",
        ] as const
      ).map((name) => spyOn(mate, name));
      process.env.PATH = `${bin}:${originalPath}`;
      show(...SECTIONS);
      jest.advanceTimersByTime(30_000);
      expect(Object.values(loads())).toEqual([1, 1, 1, 1, 1]);
      await settle();

      expect(mate.listSessions).toHaveBeenCalled();
      expect(mate.pendingArtifacts).toHaveBeenCalled();
      for (const other of others) expect(other).not.toHaveBeenCalled();
      const subcommands = new Set((await fs.readFile(log, "utf8")).trim().split("\n"));
      expect([...subcommands].toSorted()).toEqual(["config", "symbolic-ref", "worktree"]);
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(bin, { recursive: true, force: true });
    }
  });

  test("moves changes with every task checked from Open changes to Ready to archive", async () => {
    const repo = await openRepository();
    const changes = path.join(repo, ".mate/companion/openspec/changes");
    const write = async (name: string, tasks?: string, branch?: string) => {
      await fs.mkdir(path.join(changes, name), { recursive: true });
      if (tasks !== undefined) await fs.writeFile(path.join(changes, name, "tasks.md"), tasks);
      if (branch) {
        await fs.writeFile(
          path.join(changes, name, "delivery.yaml"),
          `deliveries:\n  - branch: ${branch}\n`,
        );
      }
    };
    await write("acme-queue", "- [x] a\n- [x] b\n", "workset/acme");
    await write("acme-retry", "- [x] a\n- [ ] b\n", "workset/acme");
    await write("acme-done", "- [x] a\n", "workset/acme-done");
    await write("acme-draft");

    const open = await providers.get("mate.openChanges")!.getChildren();
    expect(open.map((item) => [item.label, item.description])).toEqual([
      ["acme", "1/2 tasks"],
      ["acme-draft", "0/0 tasks"],
    ]);
    const ready = await providers.get("mate.readyToArchive")!.getChildren();
    expect(ready.map((item) => [item.label, item.description])).toEqual([
      ["acme-done", "1/1 · acme-done"],
      ["acme-queue", "2/2 · acme"],
    ]);
    expect(ready[0]!.command?.arguments).toEqual([
      { fsPath: path.join(changes, "acme-done/tasks.md"), scheme: "file" },
    ]);
  });

  test("starts a session in a Worktrees item's worktree without asking for the directory", async () => {
    const repo = await openRepository();
    const add = (await import("bun:test")).spyOn(mate, "addSession");
    add.mockImplementation(async () => ({}) as never);
    const [item] = await providers.get("mate.worktrees")!.getChildren();
    expect(item!.contextValue).toBe("worktree");

    pickLabel = undefined;
    await handlers.get("mate.newSession")!(item);
    expect(add).not.toHaveBeenCalled();

    picks.length = 0;
    pickLabel = "OpenCode";
    await handlers.get("mate.newSession")!(item);
    expect(picks).toEqual(["Agent Runtime"]);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]![0]).toMatchObject({ runtime: "opencode", cwd: repo });
    expect(terminals.at(-1)!.cwd).toBe(repo);
    expect(terminals.at(-1)!.sent[0]).toStartWith("mate opencode -- --bg --session ses_");
  });

  test("an umbrella window spans its children in every section", async () => {
    const acme = await umbrellaFixture();
    root = acme.root;
    const file = path.join(acme.umbrella, ".mate/acme.mate.code-workspace");
    await fs.writeFile(file, "{}");
    const changes = path.join(acme.umbrella, ".mate/companion/openspec/changes");
    await fs.mkdir(path.join(changes, "acme-fix"), { recursive: true });
    await fs.writeFile(path.join(changes, "acme-fix/tasks.md"), "- [x] a\n- [ ] b\n");
    await fs.writeFile(
      path.join(changes, "acme-fix/delivery.yaml"),
      [
        "deliveries:",
        "  - repository: acme/api",
        "    branch: workset/acme-fix",
        "  - repository: acme/web",
        "    branch: workset/acme-fix",
        "",
      ].join("\n"),
    );
    const at = (id: string, cwd: string, branch?: string): Session => ({
      ...session(id, new Date().toISOString(), branch),
      cwd,
      ...(branch ? {} : { branch: undefined }),
    });
    workspace.workspaceFolders = [{ uri: { fsPath: acme.umbrella, scheme: "file" } }];
    workspace.workspaceFile = { fsPath: file, scheme: "file" };
    const { spyOn } = await import("bun:test");
    spyOn(mate, "listSessions").mockImplementation(async () => [
      at("acme-umbrella", acme.umbrella),
      at("acme-api", acme.api, "main"),
      at("acme-fix-web", path.join(acme.mirrored, "web"), "workset/acme-fix"),
      at("acme-fix", acme.mirrored, "workset/acme-fix"),
      at("acme-elsewhere", acme.plain, "workset/acme-fix"),
    ]);
    spyOn(mate, "pendingArtifacts").mockImplementation(async () => ({ pending: [] }));
    activate({ subscriptions } as never);
    await handlers.get("mate.refresh")!();
    expect(contexts.get("mate.workspaceReady")).toBe(true);

    const open = await providers.get("mate.openChanges")!.getChildren();
    expect(open.map((item) => [item.label, item.description])).toEqual([
      ["acme-fix", "1/2 tasks · 2 sessions"],
    ]);
    const groups = await providers.get("mate.sessions")!.getChildren();
    expect(groups.map((group) => [group.label, group.children?.length])).toEqual([
      ["acme-fix", 2],
      ["main", 1],
      ["No branch", 1],
    ]);
    const worktrees = await providers.get("mate.worktrees")!.getChildren();
    expect(
      worktrees.map((item) => [
        item.label,
        item.description,
        item.children?.map((child) => [child.label, child.description]),
      ]),
    ).toEqual([
      ["acme-fix", "workset/acme-fix · Workset", undefined],
      ["api", undefined, [["scratch", "spike"]]],
    ]);
    expect(worktrees[0]!.command?.arguments).toEqual([
      { fsPath: acme.mirrored, scheme: "file" },
      { forceNewWindow: true },
    ]);
  });

  test("contributes one native welcome view instead of five repeated gates", async () => {
    const manifest = await Bun.file(path.join(import.meta.dir, "../package.json")).json();
    const views = manifest.contributes.views.mate;
    expect(
      views
        .filter((view: { when: string }) => view.when === "!mate.workspaceReady")
        .map((view: { id: string }) => view.id),
    ).toEqual(["mate.workspace"]);
    expect(
      views
        .filter((view: { when: string }) => view.when === "mate.workspaceReady")
        .map((view: { id: string }) => view.id),
    ).toEqual([
      "mate.sessions",
      "mate.worktrees",
      "mate.openChanges",
      "mate.readyToArchive",
      "mate.readyToPublish",
    ]);
    expect(
      manifest.contributes.viewsWelcome.filter((view: { contents: string }) =>
        view.contents.includes("command:mate.openWorkspace"),
      ),
    ).toHaveLength(1);
  });
});
