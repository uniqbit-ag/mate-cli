import start from "../views/getting-started/start.md?raw";
import vscode from "../views/getting-started/vscode.md?raw";
import worktrees from "../views/getting-started/worktrees.md?raw";
import { compileGuides } from "./guide-content";

export const guides = compileGuides({
  start: { source: start, path: "start.md", title: "Start here" },
  worktrees: { source: worktrees, path: "worktrees.md", title: "Worktrees" },
  vscode: { source: vscode, path: "vscode.md", title: "VS Code & Cursor" },
});
