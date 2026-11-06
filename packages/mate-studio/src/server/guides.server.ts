import worktrees from "../../../../apps/docs/content/docs/concepts/worktrees.mdx?raw";
import vscode from "../../../../apps/docs/content/docs/getting-started/vscode.mdx?raw";
import start from "../views/getting-started/start.md?raw";
import { compileGuides } from "./guide-content";

export const guides = compileGuides({
  start: { source: start, path: "start.md", title: "Start here" },
  worktrees: { source: worktrees, path: "concepts/worktrees.mdx", title: "Worktrees" },
  vscode: { source: vscode, path: "getting-started/vscode.mdx", title: "VS Code & Cursor" },
});
