import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { frameworkConfig } from "../../framework";

const getGlobalConfigDir = () => path.join(os.homedir(), `.${frameworkConfig.name}`);

/**
 * @command mate config
 * @description Opens the global mate config directory (`~/.<frameworkName>`) in the
 * OS's default file manager (Finder/Explorer/xdg-open), or in VS Code when `--vscode`
 * is passed.
 * @flags
 * - `--vscode` — open the directory in VS Code instead of the OS file manager.
 */
export async function runConfigCommand(argv: string[]): Promise<void> {
  const vscode = argv.includes("--vscode");

  if (vscode) {
    execSync(`code "${getGlobalConfigDir()}"`, { stdio: "inherit" });
  } else {
    const platform = process.platform;
    if (platform === "darwin") {
      execSync(`open "${getGlobalConfigDir()}"`, { stdio: "inherit" });
    } else if (platform === "win32") {
      execSync(`explorer "${getGlobalConfigDir()}"`, { stdio: "inherit" });
    } else {
      execSync(`xdg-open "${getGlobalConfigDir()}"`, { stdio: "inherit" });
    }
  }
}
