import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as vscode from "vscode";

import { readOpenChanges, readyToArchive, type OpenChange } from "./changes";
import {
  groupSessions,
  latestSession,
  sessionLabel,
  worksetProgress,
  worksetSessions,
  worksetLabel,
  worksetsOf,
  type SessionGroupKind,
  type Workset,
} from "./groups";
import { ICONS, type Icon } from "./icons";
import {
  addSession,
  claudeAgents,
  claudeSupportsBackground,
  EDITOR_SESSION_ENV,
  listSessions,
  pendingArtifacts,
  removeSession,
  startClaudeBackground,
  stopClaude,
  stopOpenCode,
  prepareWorkspace,
  type BackgroundStart,
} from "./mate";
import { toPendingItems } from "./pending";
import { intervalSeconds, ReloadGate } from "./reload";
import {
  defaultBranch,
  listWorktrees,
  repositoryId,
  repositoryRoots,
  resolveRepository,
  umbrellaWorktrees,
  type WindowRepository,
} from "./repository";
import { Section, type SectionItem, type SectionLoad } from "./section";
import {
  attachable,
  attachCommand,
  daemonId,
  launchCommand,
  newSessionId,
  resumeCommand,
  sessionsForRepository,
  terminalName,
  type Runtime,
  type Session,
} from "./sessions";
import { TerminalTracker } from "./terminals";
import type { Worktree } from "./worktrees";
import { WorkspaceGate, resolveWorkspaceState } from "./workspace";

const NO_REPOSITORY =
  "Mate needs a Git repository or a linked umbrella folder: open a folder inside a repository, or the umbrella folder itself.";
const NOT_LINKED = "This repository is not linked to a Companion Repository.";

function workspaceRepository(): Promise<WindowRepository | null> {
  return resolveRepository(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
}

/** The only root, else the one the user picks; undefined when dismissed. */
async function pickDirectory(repository: WindowRepository): Promise<string | undefined> {
  const roots = await repositoryRoots(repository);
  if (roots.length === 1) return roots[0];
  const picked = await vscode.window.showQuickPick(
    roots.map((root) => ({ label: path.basename(root), description: root, root })),
    { title: "Mate: New session", placeHolder: "Directory" },
  );
  return picked?.root;
}

function openSessionTerminal(
  session: Pick<Session, "id" | "runtime" | "cwd">,
  command: string,
): void {
  const terminal = vscode.window.createTerminal({
    name: terminalName(session),
    cwd: session.cwd,
    env: EDITOR_SESSION_ENV,
  });
  terminal.show();
  terminal.sendText(command);
}

/** The ids Delivery Records name the repository by: an umbrella's children's, else its own. */
async function deliveryIds(repository: WindowRepository): Promise<string | null | string[]> {
  if (repository.kind === "umbrella") {
    return repository.children.flatMap((child) => (child.id ? [child.id] : []));
  }
  return repositoryId(repository.root);
}

/** The default branch, or every umbrella child's. */
async function defaultBranches(repository: WindowRepository) {
  if (repository.kind === "checkout") return defaultBranch(repository.root);
  return new Set(await Promise.all(repository.children.map((child) => defaultBranch(child.path))));
}

/** Everything the Sessions and change sections share for one repository. */
async function loadRepositoryView(repository: WindowRepository) {
  const repo = repository.root;
  const [all, roots, ids, base] = await Promise.all([
    listSessions(repo),
    repositoryRoots(repository),
    deliveryIds(repository),
    defaultBranches(repository),
  ]);
  const changes = await readOpenChanges(repo, ids);
  const active: OpenChange[] = changes.linked ? changes.changes : [];
  const mine = sessionsForRepository(all, roots).filter((session) => session.state !== "done");
  return {
    sessions: mine,
    changes,
    // Sessions and Worktrees still group by every active change's Workset.
    worksets: worksetsOf(active),
    openWorksets: worksetsOf(active.filter((change) => !readyToArchive(change))),
    ready: active.filter(readyToArchive),
    defaultBranch: base,
  };
}

type RepositoryView = Awaited<ReturnType<typeof loadRepositoryView>>;

/** Both sections refresh together; a load shortly after one finished reuses it. */
const VIEW_REUSE_MS = 500;
const views = new Map<string, Promise<RepositoryView>>();

function repositoryView(repository: WindowRepository): Promise<RepositoryView> {
  const repo = repository.root;
  let view = views.get(repo);
  if (!view) {
    view = loadRepositoryView(repository);
    views.set(repo, view);
    const forget = () => setTimeout(() => views.delete(repo), VIEW_REUSE_MS);
    view.then(forget, forget);
  }
  return view;
}

const changeItem = (change: OpenChange): SectionItem => ({
  label: change.name,
  description: change.total > 0 ? `${change.done}/${change.total}` : undefined,
  icon:
    change.total > 0 && change.done === change.total
      ? ICONS.changeDone
      : change.done > 0
        ? ICONS.changeInProgress
        : ICONS.changeOpen,
  ...(change.file
    ? {
        tooltip: change.file,
        command: {
          command: "vscode.open",
          title: "Open",
          arguments: [vscode.Uri.file(change.file)],
        },
      }
    : {}),
});

/** A Ready to archive item: the change with its Workset label. */
function readyItem(change: OpenChange): SectionItem {
  const item = changeItem(change);
  const workset = change.deliveryBranch ? worksetLabel(change.deliveryBranch) : undefined;
  return {
    ...item,
    description: [item.description, workset].filter(Boolean).join(" · ") || undefined,
  };
}

export function worksetItem(workset: Workset, sessions: Session[]): SectionItem {
  const onBranch = worksetSessions(workset, sessions);
  const latest = latestSession(onBranch);
  return {
    id: `workset:${workset.key}`,
    label: workset.label,
    collapsed: true,
    description: [
      worksetProgress(workset),
      onBranch.length > 0 ? `${onBranch.length} session${onBranch.length === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
    tooltip: workset.branch,
    icon: ICONS.workset,
    contextValue: latest ? "workset.sessions" : "workset",
    data: latest,
    children: workset.changes.map(changeItem),
  };
}

function sessionOf(item: SectionItem | undefined): Session | undefined {
  return item?.data as Session | undefined;
}

/** Payload of a Worktrees item. */
interface WorktreeTarget {
  cwd: string;
}

function worktreeItem(worktree: Worktree): SectionItem {
  return {
    label: path.basename(worktree.path),
    description: [worktree.branch ?? "detached", worktree.workset ? "Workset" : ""]
      .filter(Boolean)
      .join(" · "),
    tooltip: worktree.path,
    icon: worktree.workset ? ICONS.worksetWorktree : ICONS.worktree,
    contextValue: "worktree",
    data: { cwd: worktree.path } satisfies WorktreeTarget,
    command: {
      command: "vscode.openFolder",
      title: "Open in new window",
      arguments: [vscode.Uri.file(worktree.path), { forceNewWindow: true }],
    },
  };
}

function worktreeOf(item: SectionItem | undefined): WorktreeTarget | undefined {
  return item?.contextValue === "worktree" ? (item.data as WorktreeTarget) : undefined;
}

/** Reports a session whose directory no longer exists; true when it is gone. */
function directoryGone(session: Pick<Session, "cwd">): boolean {
  if (fs.existsSync(session.cwd)) return false;
  void vscode.window.showErrorMessage(
    `Mate: the session's directory no longer exists: ${session.cwd}`,
  );
  return true;
}

const GROUP_ICONS: Record<SessionGroupKind, Icon> = {
  workset: ICONS.workset,
  branch: ICONS.branch,
  default: ICONS.defaultBranch,
  none: ICONS.defaultBranch,
  older: ICONS.older,
};

const RUNS_IN_ITS_TERMINAL =
  "Mate: this session runs in its own terminal, outside Claude's background daemon; switch to that terminal to continue it.";

const SESSIONS_INFO =
  "Mate lists only the sessions you start from this sidebar (New session, Resume). Sessions started in a terminal, such as `mate claude`, `claude`, or `mate opencode`, are not recorded: Mate writes nothing for them.\n\nClaude sessions run in Claude's background service and OpenCode sessions in the repository's Mate OpenCode server, so closing a session's terminal only detaches it; Attach reconnects and Stop ends the running turn. A Claude session without background support runs in its terminal and stops when it closes.";

const ACTIVITY_TEXT = { working: "working", idle: "idle", waiting: "waiting for you" } as const;

/** A background launch that fails this soon is retried once; Claude's cold daemon can drop one. */
const EARLY_FAILURE_MS = 30_000;
const EARLY_FAILURE_POLL_MS = 5_000;
/** Registry writes come in bursts while agents work; each reload runs `mate session list`. */
const REGISTRY_DEBOUNCE_MS = 300;

function reportWorkspaceError(error: unknown) {
  return vscode.window.showErrorMessage(
    `Mate: ${error instanceof Error ? error.message : String(error)} Check Mate setup, then try Open workspace again.`,
  );
}

export function activate(context: vscode.ExtensionContext): void {
  void Promise.all(
    ["mate.workspaceReady", "mate.workspaceCanOpen", "mate.workspaceOpening"].map((key) =>
      vscode.commands.executeCommand("setContext", key, false),
    ),
  ).catch(reportWorkspaceError);
  const terminals = new TerminalTracker();
  const workspace = new Section("mate.workspace", async () => ({ items: [] }));
  const gate = new WorkspaceGate({
    resolve: () =>
      resolveWorkspaceState(
        vscode.workspace.workspaceFolders?.[0]?.uri,
        vscode.workspace.workspaceFile,
      ),
    update: async (state) => {
      await Promise.all([
        vscode.commands.executeCommand("setContext", "mate.workspaceCanOpen", state.canOpen),
        vscode.commands.executeCommand("setContext", "mate.workspaceReady", state.ready),
      ]);
      for (const section of sections) section.refresh();
    },
    prepare: (repo) => prepareWorkspace(repo),
    open: async (workspacePath) => {
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(workspacePath), {
        forceReuseWindow: true,
      });
    },
    opening: async (value) => {
      await vscode.commands.executeCommand("setContext", "mate.workspaceOpening", value);
    },
  });
  const refreshWorkspace = () => gate.refresh().catch(reportWorkspaceError);
  const forRepository =
    (load: (repository: WindowRepository) => Promise<SectionLoad>) =>
    async (): Promise<SectionLoad> => {
      const repository = gate.state.repository;
      if (!gate.ready || !repository) return { items: [] };
      const result = await load(repository);
      return gate.ready && gate.state.repo === repository.root ? result : { items: [] };
    };

  /** Running here: a terminal of this window belongs to it. */
  const runningHere = (session: Session) => terminals.isRunning(session);
  const running = (session: Session) => runningHere(session) || session.state === "running";
  const stateText = (session: Session) => {
    if (!running(session)) return "parked";
    const activity = session.activity ? ACTIVITY_TEXT[session.activity] : undefined;
    const where = runningHere(session) ? "running" : "running elsewhere";
    return activity ? `${where}, ${activity}` : where;
  };

  const sessionItem = (session: Session, worksets: Workset[]): SectionItem => {
    const here = runningHere(session);
    const elsewhere = !here && running(session);
    const where = here ? "here" : elsewhere ? "elsewhere" : "parked";
    return {
      label: sessionLabel(session, worksets),
      description: [session.runtime, stateText(session), path.basename(session.cwd)].join(" · "),
      tooltip: [
        session.label ?? "",
        `${session.runtime} ${session.id}`,
        session.cwd,
        session.branch ? `branch ${session.branch}` : "",
        `last seen ${session.lastSeenAt ?? session.startedAt}`,
      ]
        .filter(Boolean)
        .join("\n"),
      icon:
        session.activity === "waiting" && running(session)
          ? ICONS.sessionWaiting
          : here
            ? ICONS.sessionHere
            : elsewhere
              ? ICONS.sessionElsewhere
              : ICONS.sessionParked,
      contextValue: `session.${where}.${session.runtime}${attachable(session) ? ".attachable" : ""}`,
      command: {
        command: "mate.resumeSession",
        title: "Resume",
        arguments: [{ data: session }],
      },
      data: session,
    };
  };

  /** Notifies once per newer `attentionAt` after activation, for this window's repository. */
  const activatedAt = new Date().toISOString();
  const notifiedAt = new Map<string, string>();
  const notifyAttention = (list: Session[], worksets: Workset[]) => {
    for (const session of list) {
      const at = session.attentionAt;
      if (!at || at <= activatedAt || at <= (notifiedAt.get(session.id) ?? "")) continue;
      notifiedAt.set(session.id, at);
      const label = sessionLabel(session, worksets);
      const actions = attachable(session) ? ["Attach"] : [];
      void vscode.window
        .showInformationMessage(`Mate: ${label} is waiting for you.`, ...actions)
        .then((choice) => {
          if (choice === "Attach") {
            void vscode.commands.executeCommand("mate.attachSession", { data: session });
          }
        });
    }
  };

  const sessions = new Section(
    "mate.sessions",
    forRepository(async (repository) => {
      const view = await repositoryView(repository);
      notifyAttention(view.sessions, view.worksets);
      const groups = groupSessions(view.sessions, view.worksets, view.defaultBranch, running);
      return {
        items: groups.map((group): SectionItem => ({
          id: `sessions:${group.key}`,
          label: group.label,
          description: group.description,
          icon: GROUP_ICONS[group.kind],
          collapsed: group.kind === "older",
          children: group.sessions.map((session) => sessionItem(session, view.worksets)),
        })),
      };
    }),
  );

  const worktrees = new Section(
    "mate.worktrees",
    forRepository(async (repository) => {
      // The view only adds recorded branches' Workset marks; its failure must not hide worktrees.
      const worksets = await repositoryView(repository).then(
        (view) => view.worksets,
        () => [],
      );
      const branches = new Set(worksets.flatMap((workset) => workset.branch ?? []));
      if (repository.kind === "checkout") {
        return { items: (await listWorktrees(repository.root, branches)).map(worktreeItem) };
      }
      const { mirrored, children } = await umbrellaWorktrees(repository, branches);
      return {
        items: [
          ...mirrored.map(worktreeItem),
          ...children.map((child): SectionItem => ({
            label: child.name,
            icon: ICONS.worktree,
            children: child.worktrees.map(worktreeItem),
          })),
        ],
      };
    }),
  );

  const openChanges = new Section(
    "mate.openChanges",
    forRepository(async (repository) => {
      const view = await repositoryView(repository);
      if (!view.changes.linked) return { message: NOT_LINKED };
      return {
        items: view.openWorksets.map((workset) => worksetItem(workset, view.sessions)),
      };
    }),
  );

  const readyToArchiveChanges = new Section(
    "mate.readyToArchive",
    forRepository(async (repository) => {
      const view = await repositoryView(repository);
      if (!view.changes.linked) return { message: NOT_LINKED };
      return { items: view.ready.map(readyItem) };
    }),
  );

  const readyToPublish = new Section(
    "mate.readyToPublish",
    forRepository(async (repository) => ({
      items: toPendingItems(await pendingArtifacts(repository.root)).map((item) => ({
        label: item.name,
        description: item.waitingForMerge ? "waiting for merge" : undefined,
        tooltip: item.anchor,
        icon: item.waitingForMerge ? ICONS.waitingForMerge : ICONS.readyToPublish,
      })),
    })),
  );

  const sections = [sessions, worktrees, openChanges, readyToArchiveChanges, readyToPublish];

  /** Asked once per window; without `--bg`, Claude sessions start in the foreground as before. */
  let backgroundSupport: Promise<boolean> | undefined;
  const backgroundSupported = (cwd: string) => {
    backgroundSupport ??= claudeSupportsBackground(cwd).then((supported) => {
      if (!supported) {
        void vscode.window.showWarningMessage(
          "Mate: this Claude Code cannot run background sessions (`claude --bg`); sessions start in the terminal and stop when it closes. Update Claude Code to keep them running.",
        );
      }
      return supported;
    });
    return backgroundSupport;
  };

  /** Starts (or resumes) a Claude session in the background, registers it, and attaches a terminal. */
  const startInBackground = async (cwd: string, resumeId?: string, retried = false) => {
    let started: BackgroundStart;
    try {
      started = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: resumeId
            ? "Mate: resuming Claude in the background"
            : "Mate: starting Claude in the background",
        },
        () => startClaudeBackground(cwd, resumeId),
      );
      await addSession({ id: started.sessionId, runtime: "claude", cwd });
    } catch (error) {
      return void vscode.window.showErrorMessage(`Mate: ${(error as Error).message}`);
    }
    const session = {
      id: started.sessionId,
      runtime: "claude" as const,
      cwd,
      daemonId: started.shortId,
    };
    openSessionTerminal(session, attachCommand(session));
    sessions.refresh();
    if (!retried) void retryEarlyFailure(session, resumeId);
  };

  /** Starts a new session in `cwd`: Claude in the background when it can, else in a terminal. */
  const startSession = async (runtime: Runtime, cwd: string) => {
    if (runtime === "claude" && (await backgroundSupported(cwd))) {
      await startInBackground(cwd);
      return;
    }
    const session = { id: newSessionId(runtime), runtime, cwd };
    try {
      await addSession(session);
    } catch (error) {
      return void vscode.window.showErrorMessage(
        `Mate: could not register the session: ${(error as Error).message}`,
      );
    }
    openSessionTerminal(session, launchCommand(session));
    sessions.refresh();
  };

  const retryEarlyFailure = async (
    session: Pick<Session, "id" | "runtime" | "cwd">,
    resumeId: string | undefined,
  ) => {
    // oxlint-disable no-await-in-loop -- polling, one check after another
    for (let waited = 0; waited < EARLY_FAILURE_MS; waited += EARLY_FAILURE_POLL_MS) {
      await new Promise((resolve) => setTimeout(resolve, EARLY_FAILURE_POLL_MS));
      const agent = (await claudeAgents(session.cwd)).find(
        (entry) => entry.sessionId === session.id,
      );
      if (agent?.state !== "failed") continue;
      terminals.find({ ...session, startedAt: "" })?.dispose();
      // The failed start registered its own id; a resume that kept the old id keeps its entry.
      if (session.id !== resumeId) await removeSession(session.id, os.homedir()).catch(() => {});
      await startInBackground(session.cwd, resumeId, true);
      return;
    }
    // oxlint-enable no-await-in-loop
  };

  /**
   * Automatic reloads (interval, window focus, registry) share one gate: visible
   * sections only, a few seconds apart. Hidden views reload when shown.
   */
  const reloads = new ReloadGate(() => vscode.window.state.focused);
  const reloadShown = () => {
    if (gate.ready) reloads.reload(sections);
  };

  let interval: ReturnType<typeof setInterval> | undefined;
  const startInterval = () => {
    clearInterval(interval);
    interval = undefined;
    const seconds = intervalSeconds(
      vscode.workspace.getConfiguration("mate").get("autoRefreshInterval"),
    );
    if (seconds > 0) interval = setInterval(reloadShown, seconds * 1_000);
  };
  startInterval();

  /** Hooks write the registry; reload Sessions and the Workset session counts when they do. */
  let registryTimer: ReturnType<typeof setTimeout> | undefined;
  const registryWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.join(os.homedir(), ".mate")), "sessions.json"),
  );
  const reloadRegistry = () => {
    registryTimer = undefined;
    if (!gate.ready) return;
    // Another automatic reload may have run during the debounce.
    if (reloads.wait() > 0) {
      registryTimer = setTimeout(reloadRegistry, reloads.wait());
      return;
    }
    const shown = [sessions, openChanges].filter((section) => section.view.visible);
    if (shown.length === 0) return;
    reloads.mark();
    for (const section of shown) section.refresh();
  };
  const onRegistryChange = () => {
    if (!gate.ready || registryTimer) return;
    registryTimer = setTimeout(reloadRegistry, Math.max(REGISTRY_DEBOUNCE_MS, reloads.wait()));
  };

  context.subscriptions.push(
    terminals,
    workspace,
    ...sections,
    terminals.onDidChange(() => sessions.refresh()),
    registryWatcher,
    registryWatcher.onDidChange(onRegistryChange),
    registryWatcher.onDidCreate(onRegistryChange),
    { dispose: () => clearTimeout(registryTimer) },
    { dispose: () => clearInterval(interval) },
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("mate.autoRefreshInterval")) startInterval();
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) reloadShown();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshWorkspace()),
    vscode.commands.registerCommand("mate.openWorkspace", () =>
      gate.open().catch(reportWorkspaceError),
    ),
    vscode.commands.registerCommand("mate.refresh", refreshWorkspace),
    vscode.commands.registerCommand("mate.sessionsInfo", () =>
      vscode.window.showInformationMessage("Mate sessions", {
        modal: true,
        detail: SESSIONS_INFO,
      }),
    ),

    // A Worktrees item passes its worktree, so no directory is asked.
    vscode.commands.registerCommand("mate.newSession", async (item?: SectionItem) => {
      if (!gate.ready) {
        return void vscode.window.showInformationMessage(
          "Open the Mate workspace before starting a session.",
        );
      }
      const repository = await workspaceRepository();
      if (!repository) return void vscode.window.showErrorMessage(NO_REPOSITORY);

      const runtime = await vscode.window.showQuickPick(
        [
          { label: "Claude", runtime: "claude" as Runtime },
          { label: "OpenCode", runtime: "opencode" as Runtime },
        ],
        { title: "Mate: New session", placeHolder: "Agent Runtime" },
      );
      if (!runtime) return;

      const cwd = worktreeOf(item)?.cwd || (await pickDirectory(repository));
      if (!cwd) return;
      await startSession(runtime.runtime, cwd);
    }),

    vscode.commands.registerCommand("mate.resumeSession", async (item?: SectionItem) => {
      const session = sessionOf(item);
      if (!session) return;
      const terminal = terminals.find(session);
      if (terminal) return terminal.show();
      if (directoryGone(session)) return;
      if (session.state === "running") {
        return void vscode.commands.executeCommand("mate.attachSession", item);
      }
      if (session.runtime === "claude" && (await backgroundSupported(session.cwd))) {
        await startInBackground(session.cwd, session.id);
        return;
      }
      openSessionTerminal(session, resumeCommand(session));
    }),

    vscode.commands.registerCommand("mate.attachSession", (item?: SectionItem) => {
      const session = sessionOf(item);
      if (!session) return;
      const terminal = terminals.find(session);
      if (terminal) return terminal.show();
      if (!attachable(session)) {
        return void vscode.window.showInformationMessage(RUNS_IN_ITS_TERMINAL);
      }
      if (directoryGone(session)) return;
      openSessionTerminal(session, attachCommand(session));
    }),

    vscode.commands.registerCommand("mate.stopSession", async (item?: SectionItem) => {
      const session = sessionOf(item);
      if (!session || !attachable(session)) return;
      const stop = await vscode.window.showWarningMessage(
        "Stop this session? The agent stops; the conversation is kept and can be resumed from the sidebar.",
        { modal: true },
        "Stop",
      );
      if (stop !== "Stop") return;
      const cwd = fs.existsSync(session.cwd) ? session.cwd : os.homedir();
      try {
        await (session.runtime === "claude"
          ? stopClaude(daemonId(session), cwd)
          : stopOpenCode(session.id, cwd));
      } catch (error) {
        return void vscode.window.showErrorMessage(`Mate: ${(error as Error).message}`);
      }
      terminals.find(session)?.dispose();
      sessions.refresh();
    }),

    vscode.commands.registerCommand("mate.resumeWorksetSession", (item?: SectionItem) =>
      vscode.commands.executeCommand("mate.resumeSession", item),
    ),

    vscode.commands.registerCommand("mate.removeSession", async (item?: SectionItem) => {
      const session = sessionOf(item);
      if (!session) return;
      const remove = await vscode.window.showWarningMessage(
        "Remove this session from the list? The conversation itself is kept.",
        { modal: true },
        "Remove",
      );
      if (remove !== "Remove") return;
      try {
        // The session's directory may be gone; the registry needs none.
        await removeSession(session.id, os.homedir());
      } catch (error) {
        vscode.window.showErrorMessage(`Mate: ${(error as Error).message}`);
      }
      sessions.refresh();
    }),
  );
  void refreshWorkspace();
}

export function deactivate(): void {}
