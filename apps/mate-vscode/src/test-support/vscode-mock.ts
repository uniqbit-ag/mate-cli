/**
 * Hand-rolled fake of the small `vscode` surface this extension touches, for
 * `mock.module("vscode", () => createVscodeMock())` in extension-host-style
 * tests (bun test has no real extension host; see design decision 6).
 */

export class FakeThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: unknown,
  ) {}
}

export class FakeThemeColor {
  constructor(readonly id: string) {}
}

export class FakeEventEmitter<T> {
  private readonly listeners: Array<(e: T) => void> = [];
  readonly event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(e?: T): void {
    for (const listener of this.listeners.slice()) listener(e as T);
  }
}

export class FakeTreeItem {
  description?: string;
  tooltip?: string;
  contextValue?: string;
  iconPath?: unknown;
  command?: unknown;
  constructor(
    public label: string,
    public collapsibleState?: number,
  ) {}
}

export const FakeTreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

export class FakeUri {
  private constructor(readonly fsPath: string) {}
  static file(fsPath: string): FakeUri {
    return new FakeUri(fsPath);
  }
  toString(): string {
    return `file://${this.fsPath}`;
  }
}

export interface VscodeMockCalls {
  showInformationMessage: unknown[][];
  showErrorMessage: unknown[][];
  writeText: unknown[][];
  openExternal: unknown[][];
  executeCommand: unknown[][];
  createTerminal: unknown[][];
}

export interface VscodeMockHandle {
  module: Record<string, unknown>;
  calls: VscodeMockCalls;
  isTrusted: { value: boolean };
  registeredCommands: Map<string, (...args: unknown[]) => unknown>;
  fakeTerminal: { sendText: unknown[][]; show: unknown[]; dispose: unknown[] };
}

export function createVscodeMock(): VscodeMockHandle {
  const calls: VscodeMockCalls = {
    showInformationMessage: [],
    showErrorMessage: [],
    writeText: [],
    openExternal: [],
    executeCommand: [],
    createTerminal: [],
  };
  const isTrusted = { value: true };
  const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
  const fakeTerminal = {
    sendText: [] as unknown[][],
    show: [] as unknown[],
    dispose: [] as unknown[],
  };

  const module = {
    TreeItem: FakeTreeItem,
    TreeItemCollapsibleState: FakeTreeItemCollapsibleState,
    ThemeIcon: FakeThemeIcon,
    ThemeColor: FakeThemeColor,
    EventEmitter: FakeEventEmitter,
    Uri: FakeUri,
    window: {
      showInformationMessage: (...args: unknown[]) => {
        calls.showInformationMessage.push(args);
        return Promise.resolve(undefined);
      },
      showErrorMessage: (...args: unknown[]) => {
        calls.showErrorMessage.push(args);
        return Promise.resolve(undefined);
      },
      createTerminal: (...args: unknown[]) => {
        calls.createTerminal.push(args);
        return {
          sendText: (...sendArgs: unknown[]) => fakeTerminal.sendText.push(sendArgs),
          show: () => fakeTerminal.show.push(true),
          dispose: () => fakeTerminal.dispose.push(true),
        };
      },
      registerTreeDataProvider: () => ({ dispose: () => {} }),
    },
    env: {
      clipboard: {
        writeText: (...args: unknown[]) => {
          calls.writeText.push(args);
          return Promise.resolve(undefined);
        },
      },
      openExternal: (...args: unknown[]) => {
        calls.openExternal.push(args);
        return Promise.resolve(true);
      },
    },
    commands: {
      executeCommand: (...args: unknown[]) => {
        calls.executeCommand.push(args);
        return Promise.resolve(undefined);
      },
      registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => {
        registeredCommands.set(name, handler);
        return { dispose: () => registeredCommands.delete(name) };
      },
    },
    workspace: {
      get isTrusted() {
        return isTrusted.value;
      },
      onDidGrantWorkspaceTrust: () => ({ dispose: () => {} }),
      getConfiguration: () => ({ get: () => undefined }),
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  };

  return { module, calls, isTrusted, registeredCommands, fakeTerminal };
}
