import { runWorkspaceResolveHookCommand } from "../../../packages/mate-core/src/cli/commands/workspace/resolve-hook";

void runWorkspaceResolveHookCommand(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
