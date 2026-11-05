import * as vscode from "vscode";

import { isSessionTerminal, parseTerminalName, type Session } from "./sessions";

/**
 * A session runs while a terminal named for it is open in this window. Names
 * carry the session id, so terminals VS Code restores after a reload map back.
 */
export class TerminalTracker implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];

  constructor() {
    const fire = (terminal: vscode.Terminal) => {
      if (parseTerminalName(terminal.name)) this.changed.fire();
    };
    this.subscriptions = [
      vscode.window.onDidOpenTerminal(fire),
      vscode.window.onDidCloseTerminal(fire),
    ];
  }

  find(session: Session): vscode.Terminal | undefined {
    return vscode.window.terminals.find(
      (terminal) => terminal.exitStatus === undefined && isSessionTerminal(session, terminal.name),
    );
  }

  isRunning(session: Session): boolean {
    return this.find(session) !== undefined;
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
  }
}
