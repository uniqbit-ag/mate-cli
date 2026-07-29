import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface TemporaryReportDeps {
  makeTempDir?: () => Promise<string>;
  writeFile?: (filePath: string, content: string) => Promise<void>;
  tempDir?: () => string;
}

export async function writeTemporaryReport(
  html: string,
  deps: TemporaryReportDeps = {},
): Promise<string> {
  const makeTempDir =
    deps.makeTempDir ?? (() => mkdtemp(path.join((deps.tempDir ?? os.tmpdir)(), "mate-report-")));
  const reportDirectory = await makeTempDir();
  const reportPath = path.join(reportDirectory, "report.html");
  const write = deps.writeFile ?? ((filePath, content) => writeFile(filePath, content, "utf8"));
  await write(reportPath, html);
  return reportPath;
}

export interface BrowserLauncherDeps {
  platform?: () => NodeJS.Platform;
  spawn?: typeof spawn;
}

function browserCommand(
  platform: NodeJS.Platform,
  reportPath: string,
): {
  command: string;
  args: string[];
} {
  if (platform === "darwin") {
    return { command: "open", args: [reportPath] };
  }
  if (platform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", reportPath] };
  }
  return { command: "xdg-open", args: [reportPath] };
}

export function openReportInBrowser(
  reportPath: string,
  deps: BrowserLauncherDeps = {},
): Promise<void> {
  const launch = deps.spawn ?? spawn;
  const { command, args } = browserCommand(
    (deps.platform ?? (() => process.platform))(),
    reportPath,
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };

    let child: ChildProcess;
    try {
      child = launch(command, args, { detached: true, stdio: "ignore" });
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    child.once("error", (error) => settle(error));
    child.once("spawn", () => {
      child.unref();
      settle();
    });
  });
}
