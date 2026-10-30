/**
 * Workset sandboxes use Bun as their only JavaScript runtime and package manager: a
 * command the harness sends with node, npm, npx, pnpm or yarn is rewritten to Bun before
 * it reaches the container. The image ships no other package manager.
 */

/** Where the Workset image pre-installs the Claude Code harness bridge at the pinned version. */
export const BAKED_BRIDGE_DIR = "/opt/mate/harness-bridge";

/** Every word is matched whole; the rest of the command is kept as it was sent. */
const INSTALL = /^(?:pnpm|npm|yarn)\s+(?:install|i|ci)(?=\s|$)(.*)$/s;
const RUN = /^(?:pnpm|npm|yarn)\s+run(?=\s)/;
const EXEC = /^(?:pnpm\s+(?:exec|dlx)|yarn\s+dlx|npx)(?=\s)/;
const NODE = /^node(?=\s)/;

/**
 * An install reuses the baked bridge's packages when the directory's manifest is the
 * baked one, which is how the harness's bootstrap finishes without a download.
 * Package-manager options such as `--store-dir` have no Bun meaning and are dropped.
 */
function bunInstall(args: string, ci: boolean): string {
  const frozen = ci || /(?:^|\s)--frozen-lockfile(?=\s|$)/.test(args) ? " --frozen-lockfile" : "";
  return (
    `if cmp -s package.json ${BAKED_BRIDGE_DIR}/package.json && test -d ${BAKED_BRIDGE_DIR}/node_modules; ` +
    `then ln -sfn ${BAKED_BRIDGE_DIR}/node_modules node_modules; ` +
    `else bun install${frozen}; fi`
  );
}

/** The command as the sandbox runs it; anything that names no Node tool is unchanged. */
export function bunCommand(command: string): string {
  const trimmed = command.trimStart();
  const install = INSTALL.exec(trimmed);
  if (install) return bunInstall(install[1] ?? "", /^npm\s+ci(?=\s|$)/.test(trimmed));
  if (RUN.test(trimmed)) return trimmed.replace(RUN, "bun run");
  if (EXEC.test(trimmed)) return trimmed.replace(EXEC, "bunx");
  if (NODE.test(trimmed)) return trimmed.replace(NODE, "bun");
  return command;
}
