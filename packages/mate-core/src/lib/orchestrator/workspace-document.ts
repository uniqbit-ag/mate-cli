import path from "node:path";

import {
  type FormattingOptions,
  type Node,
  type ParseError,
  applyEdits,
  findNodeAtLocation,
  getNodeValue,
  modify,
  parseTree,
  printParseErrorCode,
} from "jsonc-parser";

/** Added to the workspace `settings` only when the key is absent; a developer value wins. */
const MANAGED_WORKSPACE_SETTINGS: Readonly<Record<string, unknown>> = {
  "git.detectWorktrees": true,
  "scm.alwaysShowRepositories": true,
};

export type WorkspaceDocumentMerge =
  | { kind: "unchanged" }
  | { kind: "changed"; text: string }
  | { kind: "invalid"; problem: string };

interface WorkspaceDocumentMergeInput {
  /** Current file text; `null` when the file does not exist. */
  existing: string | null;
  /** Directory relative folder paths resolve against, as in VS Code. */
  documentDir: string;
  folders: string[];
}

/**
 * Additive JSONC merge of a `.code-workspace` document: appends each folder no
 * entry names by resolved path and each absent managed setting key. Never
 * removes or overwrites; edits keep comments, trailing commas, and untouched
 * lines.
 */
export function mergeWorkspaceDocument({
  existing,
  documentDir,
  folders,
}: WorkspaceDocumentMergeInput): WorkspaceDocumentMerge {
  let text = existing ?? "{}";
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  const [error] = errors;
  if (error) {
    const line = text.slice(0, error.offset).split("\n").length;
    return {
      kind: "invalid",
      problem: `invalid JSONC: ${printParseErrorCode(error.error)} at line ${line}`,
    };
  }
  if (root?.type !== "object") return { kind: "invalid", problem: "root is not an object" };

  const foldersNode = findNodeAtLocation(root, ["folders"]);
  if (foldersNode && foldersNode.type !== "array") {
    return { kind: "invalid", problem: '"folders" is not an array' };
  }
  const settingsNode = findNodeAtLocation(root, ["settings"]);
  if (settingsNode && settingsNode.type !== "object") {
    return { kind: "invalid", problem: '"settings" is not an object' };
  }

  const present = new Set(listedFolderPaths(foldersNode, documentDir));
  const missingFolders = [...new Set(folders.map((folder) => path.resolve(folder)))].filter(
    (folder) => !present.has(folder),
  );
  const missingSettings = Object.entries(MANAGED_WORKSPACE_SETTINGS).filter(
    ([key]) => !settingsNode || !findNodeAtLocation(settingsNode, [key]),
  );
  if (missingFolders.length === 0 && missingSettings.length === 0) return { kind: "unchanged" };

  const formattingOptions: FormattingOptions = {
    tabSize: 2,
    insertSpaces: true,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  };
  for (const folder of missingFolders) {
    text = applyEdits(
      text,
      modify(
        text,
        ["folders", -1],
        { path: folder },
        { formattingOptions, isArrayInsertion: true },
      ),
    );
  }
  for (const [key, value] of missingSettings) {
    text = applyEdits(text, modify(text, ["settings", key], value, { formattingOptions }));
  }
  if (existing === null) text += formattingOptions.eol;
  return { kind: "changed", text };
}

function listedFolderPaths(foldersNode: Node | undefined, documentDir: string): string[] {
  return (foldersNode?.children ?? []).flatMap((entry) => {
    const value: unknown = entry.type === "object" ? getNodeValue(entry) : null;
    const folderPath = (value as { path?: unknown } | null)?.path;
    return typeof folderPath === "string" ? [path.resolve(documentDir, folderPath)] : [];
  });
}
