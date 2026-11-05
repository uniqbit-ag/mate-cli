import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as vscode from "vscode";

import { readOpenChanges, type OpenChange } from "./changes";
import {
  groupSessions,
  latestSession,
  sessionLabel,
  worksetSessions,
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
  type BackgroundStart,
} from "./mate";
import { toPendingItems } from "./pending";
import { defaultBranch, listWorktrees, repositoryId, resolveRepository } from "./repository";
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

const NO_REPOSITORY = "Mate needs a Git repository: open a folder inside one.";

function workspaceRepository(): Promise<string | null> {
  return resolveRepository(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
}

/** Runs `load` for the window's repository, or shows the needs-a-repository message. */
function forRepository(load: (repo: string) => Promise<SectionLoad>): () => Promise<SectionLoad> {
  return async () => {
    const repo = await workspaceRepository();
    return repo ? load(repo) : { message: NO_REPOSITORY };
  };
}

async function repositoryRoots(repo: string): Promise<string[]> {
  const worktrees = await listWorktrees(repo).catch(() => []);
  return worktrees.length > 0 ? worktrees.map((worktree) => worktree.path) : [repo];
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

/** Everything the Sessions and Open changes sections share for one repository. */
async function loadRepositoryView(repo: string) {
  const [all, roots, id, base] = await Promise.all([
    listSessions(repo),
    repositoryRoots(repo),
    repositoryId(repo),
    defaultBranch(repo),
  ]);
  const changes = await readOpenChanges(repo, id);
  const openChanges: OpenChange[] = changes.linked ? changes.changes : [];
  const mine = sessionsForRepository(all, roots).filter((session) => session.state !== "done");
  return { sessions: mine, changes, worksets: worksetsOf(openChanges), defaultBranch: base };
}

type RepositoryView = Awaited<ReturnType<typeof loadRepositoryView>>;

/** Both sections refresh together; a load shortly after one finished reuses it. */
const VIEW_REUSE_MS = 500;
const views = new Map<string, Promise<RepositoryView>>();

function repositoryView(repo: string): Promise<RepositoryView> {
  let view = views.get(repo);
  if (!view) {
    view = loadRepositoryView(repo);
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

function sessionOf(item: SectionItem | undefined): Session | undefined {
  return item?.data as Session | undefined;
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
const REGISTRY_MIN_INTERVAL_MS = 3_000;

export function activate(context: vscode.ExtensionContext): void {
  const terminals = new TerminalTracker();

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
    forRepository(async (repo) => {
      const view = await repositoryView(repo);
      notifyAttention(view.sessions, view.worksets);
      const groups = groupSessions(view.sessions, view.worksets, view.defaultBranch, running);
      return {
        items: groups.map((group): SectionItem => ({
          label: group.label,
          description: group.kind === "workset" ? "Workset" : undefined,
          icon: GROUP_ICONS[group.kind],
          collapsed: group.kind === "older",
          children: group.sessions.map((session) => sessionItem(session, view.worksets)),
        })),
      };
    }),
  );

  const worktrees = new Section(
    "mate.worktrees",
    forRepository(async (repo) => ({
      items: (await listWorktrees(repo)).map((worktree) => ({
        label: path.basename(worktree.path),
        description: [worktree.branch ?? "detached", worktree.workset ? "Workset" : ""]
          .filter(Boolean)
          .join(" · "),
        tooltip: worktree.path,
        icon: worktree.workset ? ICONS.worksetWorktree : ICONS.worktree,
        command: {
          command: "vscode.openFolder",
          title: "Open in new window",
          arguments: [vscode.Uri.file(worktree.path), { forceNewWindow: true }],
        },
      })),
    })),
  );

  const openChanges = new Section(
    "mate.openChanges",
    forRepository(async (repo) => {
      const view = await repositoryView(repo);
      if (!view.changes.linked) {
        return { message: "This repository is not linked to a Companion Repository." };
      }
      return {
        items: view.worksets.map((workset): SectionItem => {
          const onBranch = worksetSessions(workset, view.sessions);
          const latest = latestSession(onBranch);
          return {
            label: workset.label,
            description: [
              workset.branch ? "Workset" : "",
              onBranch.length > 0
                ? `${onBranch.length} session${onBranch.length === 1 ? "" : "s"}`
                : "",
            ]
              .filter(Boolean)
              .join(" · "),
            tooltip: workset.branch,
            icon: ICONS.workset,
            contextValue: latest ? "workset.sessions" : "workset",
            data: latest,
            children: workset.changes.map(changeItem),
          };
        }),
      };
    }),
  );

  const readyToPublish = new Section(
    "mate.readyToPublish",
    forRepository(async (repo) => ({
      items: toPendingItems(await pendingArtifacts(repo)).map((item) => ({
        label: item.name,
        description: item.waitingForMerge ? "waiting for merge" : undefined,
        tooltip: item.anchor,
        icon: item.waitingForMerge ? ICONS.waitingForMerge : ICONS.readyToPublish,
      })),
    })),
  );

  const sections = [sessions, worktrees, openChanges, readyToPublish];
  const refreshAll = () => {
    for (const section of sections) section.refresh();
  };

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
   * Hooks write the registry; reload Sessions and the Workset session counts
   * when they do, at most every few seconds. Hidden views reload when shown.
   */
  let registryTimer: ReturnType<typeof setTimeout> | undefined;
  let registryReloadedAt = 0;
  const registryWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.join(os.homedir(), ".mate")), "sessions.json"),
  );
  const onRegistryChange = () => {
    if (registryTimer) return;
    const wait = Math.max(
      REGISTRY_DEBOUNCE_MS,
      registryReloadedAt + REGISTRY_MIN_INTERVAL_MS - Date.now(),
    );
    registryTimer = setTimeout(() => {
      registryTimer = undefined;
      const shown = [sessions, openChanges].filter((section) => section.view.visible);
      if (shown.length === 0) return;
      registryReloadedAt = Date.now();
      for (const section of shown) section.refresh();
    }, wait);
  };

  context.subscriptions.push(
    terminals,
    ...sections,
    terminals.onDidChange(() => sessions.refresh()),
    registryWatcher,
    registryWatcher.onDidChange(onRegistryChange),
    registryWatcher.onDidCreate(onRegistryChange),
    { dispose: () => clearTimeout(registryTimer) },
    vscode.commands.registerCommand("mate.refresh", refreshAll),
    vscode.commands.registerCommand("mate.sessionsInfo", () =>
      vscode.window.showInformationMessage("Mate sessions", {
        modal: true,
        detail: SESSIONS_INFO,
      }),
    ),

    vscode.commands.registerCommand("mate.newSession", async () => {
      const repo = await workspaceRepository();
      if (!repo) return void vscode.window.showErrorMessage(NO_REPOSITORY);

      const runtime = await vscode.window.showQuickPick(
        [
          { label: "Claude", runtime: "claude" as Runtime },
          { label: "OpenCode", runtime: "opencode" as Runtime },
        ],
        { title: "Mate: New session", placeHolder: "Agent Runtime" },
      );
      if (!runtime) return;

      const roots = await repositoryRoots(repo);
      const cwd =
        roots.length === 1
          ? roots[0]
          : (
              await vscode.window.showQuickPick(
                roots.map((root) => ({ label: path.basename(root), description: root, root })),
                { title: "Mate: New session", placeHolder: "Directory" },
              )
            )?.root;
      if (!cwd) return;

      if (runtime.runtime === "claude" && (await backgroundSupported(cwd))) {
        await startInBackground(cwd);
        return;
      }
      const session = { id: newSessionId(runtime.runtime), runtime: runtime.runtime, cwd };
      try {
        await addSession(session);
      } catch (error) {
        return void vscode.window.showErrorMessage(
          `Mate: could not register the session: ${(error as Error).message}`,
        );
      }
      openSessionTerminal(session, launchCommand(session));
      sessions.refresh();
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
}

export function deactivate(): void {}
