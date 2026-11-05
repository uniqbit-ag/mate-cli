import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as vscode from "vscode";

import { readOpenChanges } from "./changes";
import { addSession, listSessions, pendingArtifacts, removeSession } from "./mate";
import { toPendingItems } from "./pending";
import { listWorktrees, resolveRepository } from "./repository";
import { Section, type SectionItem, type SectionLoad } from "./section";
import {
  launchCommand,
  newSessionId,
  resumeCommand,
  sessionsForRepository,
  shortId,
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
  const terminal = vscode.window.createTerminal({ name: terminalName(session), cwd: session.cwd });
  terminal.show();
  terminal.sendText(command);
}

function sessionOf(item: SectionItem | undefined): Session | undefined {
  return item?.data as Session | undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  const terminals = new TerminalTracker();

  const sessions = new Section(
    "mate.sessions",
    forRepository(async (repo) => {
      const all = await listSessions(repo);
      const mine = sessionsForRepository(all, await repositoryRoots(repo));
      return {
        items: mine.map((session): SectionItem => {
          const running = terminals.isRunning(session);
          return {
            label: `${session.runtime} · ${shortId(session.id)}`,
            description: `${running ? "running" : "parked"} · ${path.basename(session.cwd)}`,
            tooltip: `${session.id}\n${session.cwd}\nstarted ${session.startedAt}`,
            icon: running ? "terminal" : "debug-pause",
            contextValue: running ? "session.running" : "session.parked",
            command: {
              command: "mate.resumeSession",
              title: "Resume",
              arguments: [{ data: session }],
            },
            data: session,
          };
        }),
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
        icon: worktree.workset ? "git-branch" : "folder",
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
      const result = await readOpenChanges(repo);
      if (!result.linked) {
        return { message: "This repository is not linked to a Companion Repository." };
      }
      return {
        items: result.changes.map((change) => ({
          label: change.name,
          description: change.total > 0 ? `${change.done}/${change.total}` : undefined,
          icon: change.total > 0 && change.done === change.total ? "pass" : "circle-outline",
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
        })),
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
        icon: item.waitingForMerge ? "git-pull-request" : "cloud-upload",
      })),
    })),
  );

  const sections = [sessions, worktrees, openChanges, readyToPublish];
  const refreshAll = () => {
    for (const section of sections) section.refresh();
  };

  context.subscriptions.push(
    terminals,
    ...sections,
    terminals.onDidChange(() => sessions.refresh()),
    vscode.commands.registerCommand("mate.refresh", refreshAll),

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

    vscode.commands.registerCommand("mate.resumeSession", (item?: SectionItem) => {
      const session = sessionOf(item);
      if (!session) return;
      const terminal = terminals.find(session);
      if (terminal) return terminal.show();
      if (!fs.existsSync(session.cwd)) {
        return void vscode.window.showErrorMessage(
          `Mate: the session's directory no longer exists: ${session.cwd}`,
        );
      }
      openSessionTerminal(session, resumeCommand(session));
    }),

    vscode.commands.registerCommand("mate.parkSession", async (item?: SectionItem) => {
      const session = sessionOf(item);
      const terminal = session && terminals.find(session);
      if (!terminal) return;
      const park = await vscode.window.showWarningMessage(
        "Park this session? Its terminal closes and the agent stops; resume it later from the sidebar.",
        { modal: true },
        "Park",
      );
      if (park === "Park") terminal.dispose();
    }),

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
