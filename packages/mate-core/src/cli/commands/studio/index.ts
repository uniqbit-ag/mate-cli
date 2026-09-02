import { FRAMEWORK_NAME } from "../../../framework";
import { openReportInBrowser } from "../report/delivery";
import { serveUntilInterrupted, startStudioServer } from "./server";

export interface StudioCommandDeps {
  startStudioServer?: typeof startStudioServer;
  serveUntilInterrupted?: typeof serveUntilInterrupted;
  openInBrowser?: (url: string) => Promise<void>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/**
 * @command mate studio
 * @description Serves a local, read-only page over the Companion Repositories
 * registered on this machine — the workflow drawn from each companion's
 * resolved schema with its OpenSpec state on it — and opens the platform
 * browser at it. Runs in the foreground on an operating-system-assigned
 * loopback port and dies with the process: no daemon, no stop command, and no
 * state written anywhere.
 * @remarks Takes no arguments and resolves no Repository Link, so it runs from
 * any directory.
 */
export async function runStudioCommand(
  argv: string[] = [],
  deps: StudioCommandDeps = {},
): Promise<void> {
  const log = deps.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const warn = deps.warn ?? ((message: string) => process.stderr.write(`${message}\n`));

  if (argv.length > 0) {
    warn(`${FRAMEWORK_NAME}: \`studio\` takes no arguments; unrecognized: ${argv.join(" ")}`);
    process.exitCode = 1;
    return;
  }

  const start = deps.startStudioServer ?? startStudioServer;
  const serve = deps.serveUntilInterrupted ?? serveUntilInterrupted;
  const open = deps.openInBrowser ?? openReportInBrowser;

  let server;
  try {
    server = start();
  } catch (error) {
    warn(
      `${FRAMEWORK_NAME}: studio could not bind a port: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
    return;
  }

  log(server.url);
  log("Press Ctrl+C to stop.");

  try {
    await open(server.url);
  } catch (error) {
    warn(
      `${FRAMEWORK_NAME}: studio could not open a browser: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    warn(`${FRAMEWORK_NAME}: open ${server.url} manually; the server keeps serving.`);
  }

  await serve(server);
}
