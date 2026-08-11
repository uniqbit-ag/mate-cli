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
  private constructor(
    readonly fsPath: string,
    readonly scheme: string = "file",
  ) {}
  static file(fsPath: string): FakeUri {
    return new FakeUri(fsPath, "file");
  }
  static parse(value: string): FakeUri {
    const [scheme, ...rest] = value.split(":");
    return new FakeUri(rest.join(":"), scheme);
  }
  toString(): string {
    return `${this.scheme}:${this.fsPath}`;
  }
}

export class FakeRange {
  constructor(
    readonly startLine: number,
    readonly startCol: number,
    readonly endLine: number,
    readonly endCol: number,
  ) {}
}

export class FakeDiagnostic {
  source?: string;
  constructor(
    readonly range: FakeRange,
    readonly message: string,
    readonly severity: number,
  ) {}
}

export const FakeDiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

export class FakeDiagnosticCollection {
  private readonly entries = new Map<string, unknown[]>();
  set(uri: FakeUri, diagnostics: unknown[]): void {
    this.entries.set(uri.toString(), diagnostics);
  }
  get(uri: FakeUri): unknown[] | undefined {
    return this.entries.get(uri.toString());
  }
  clear(): void {
    this.entries.clear();
  }
  dispose(): void {
    this.entries.clear();
  }
  get size(): number {
    return this.entries.size;
  }
}

export class FakeStatusBarItem {
  text = "";
  tooltip?: string;
  command?: unknown;
  backgroundColor?: unknown;
  show(): void {}
  dispose(): void {}
}

export const FakeStatusBarAlignment = { Left: 1, Right: 2 };

export interface VscodeMockCalls {
  showInformationMessage: unknown[][];
  showErrorMessage: unknown[][];
  writeText: unknown[][];
  openExternal: unknown[][];
  executeCommand: unknown[][];
  createTerminal: unknown[][];
  showQuickPick: unknown[][];
  updateWorkspaceFolders: unknown[][];
  showTextDocument: unknown[][];
}

export interface VscodeMockHandle {
  module: Record<string, unknown>;
  calls: VscodeMockCalls;
  isTrusted: { value: boolean };
  registeredCommands: Map<string, (...args: unknown[]) => unknown>;
  fakeTerminal: { sendText: unknown[][]; show: unknown[]; dispose: unknown[] };
  workspaceFolders: { value: Array<{ uri: FakeUri }> };
  quickPickResult: { value: unknown };
  configuration: { value: Record<string, unknown> };
  diagnosticCollections: FakeDiagnosticCollection[];
  treeViews: Map<string, { reveal: unknown[][] }>;
  /** Set `.fn` to a rejecting function to simulate "no such document" (e.g. a missing proposal.md). */
  openTextDocumentBehavior: { fn: (uri: FakeUri) => Promise<unknown> };
}

export function createVscodeMock(): VscodeMockHandle {
  const calls: VscodeMockCalls = {
    showInformationMessage: [],
    showErrorMessage: [],
    writeText: [],
    openExternal: [],
    executeCommand: [],
    createTerminal: [],
    showQuickPick: [],
    updateWorkspaceFolders: [],
    showTextDocument: [],
  };
  const isTrusted = { value: true };
  const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
  const fakeTerminal = {
    sendText: [] as unknown[][],
    show: [] as unknown[],
    dispose: [] as unknown[],
  };
  const workspaceFolders: { value: Array<{ uri: FakeUri }> } = { value: [] };
  const quickPickResult: { value: unknown } = { value: undefined };
  const configuration: { value: Record<string, unknown> } = { value: {} };
  const diagnosticCollections: FakeDiagnosticCollection[] = [];
  const treeViews = new Map<string, { reveal: unknown[][] }>();
  const openTextDocumentBehavior: { fn: (uri: FakeUri) => Promise<unknown> } = {
    fn: (uri) => Promise.resolve({ uri }),
  };

  const module = {
    TreeItem: FakeTreeItem,
    TreeItemCollapsibleState: FakeTreeItemCollapsibleState,
    ThemeIcon: FakeThemeIcon,
    ThemeColor: FakeThemeColor,
    EventEmitter: FakeEventEmitter,
    Uri: FakeUri,
    Range: FakeRange,
    Diagnostic: FakeDiagnostic,
    DiagnosticSeverity: FakeDiagnosticSeverity,
    StatusBarAlignment: FakeStatusBarAlignment,
    window: {
      showInformationMessage: (...args: unknown[]) => {
        calls.showInformationMessage.push(args);
        return Promise.resolve(undefined);
      },
      showErrorMessage: (...args: unknown[]) => {
        calls.showErrorMessage.push(args);
        return Promise.resolve(undefined);
      },
      showQuickPick: (...args: unknown[]) => {
        calls.showQuickPick.push(args);
        return Promise.resolve(quickPickResult.value);
      },
      createTerminal: (...args: unknown[]) => {
        calls.createTerminal.push(args);
        return {
          sendText: (...sendArgs: unknown[]) => fakeTerminal.sendText.push(sendArgs),
          show: () => fakeTerminal.show.push(true),
          dispose: () => fakeTerminal.dispose.push(true),
        };
      },
      createStatusBarItem: () => new FakeStatusBarItem(),
      showTextDocument: (...args: unknown[]) => {
        calls.showTextDocument.push(args);
        return Promise.resolve(undefined);
      },
      registerTreeDataProvider: () => ({ dispose: () => {} }),
      createTreeView: (viewId: string) => {
        const reveal: unknown[][] = [];
        const treeView = {
          reveal: (...args: unknown[]) => {
            reveal.push(args);
            return Promise.resolve(undefined);
          },
          dispose: () => {},
        };
        treeViews.set(viewId, { reveal });
        return treeView;
      },
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
      get workspaceFolders() {
        return workspaceFolders.value;
      },
      onDidGrantWorkspaceTrust: () => ({ dispose: () => {} }),
      getConfiguration: () => ({ get: (key: string) => configuration.value[key] }),
      updateWorkspaceFolders: (...args: unknown[]) => {
        calls.updateWorkspaceFolders.push(args);
        return true;
      },
      registerTextDocumentContentProvider: () => ({ dispose: () => {} }),
      openTextDocument: (uri: FakeUri) => openTextDocumentBehavior.fn(uri),
    },
    languages: {
      createDiagnosticCollection: () => {
        const collection = new FakeDiagnosticCollection();
        diagnosticCollections.push(collection);
        return collection;
      },
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  };

  return {
    module,
    calls,
    isTrusted,
    registeredCommands,
    fakeTerminal,
    workspaceFolders,
    quickPickResult,
    configuration,
    diagnosticCollections,
    treeViews,
    openTextDocumentBehavior,
  };
}
