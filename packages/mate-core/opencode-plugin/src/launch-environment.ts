import { MATE_ENV } from "../../src/runtime/env-names";

export type LaunchEnvironment = Record<string, string | undefined>;

/**
 * True inside OpenCode's shared background service (`opencode serve --service`),
 * which hosts plugins in-process for every bare `opencode` session. Its
 * environment belongs to whichever process started it, not to any session.
 */
export function runsInSharedService(argv: readonly string[]): boolean {
  return argv.includes("serve") && argv.includes("--service");
}

/**
 * The environment the plugin may treat as a Mate launch environment: `env`
 * itself for a managed launch, `{}` otherwise so every reader falls back to
 * the Projection Root.
 *
 * Inherited `MATE_*` variables prove nothing — every shell under a Mate session
 * carries them. The guidance payload does: only `mate opencode` sets it, and
 * the plugin masks it in every shell it configures.
 */
export function pluginLaunchEnvironment(
  env: LaunchEnvironment,
  argv: readonly string[],
): LaunchEnvironment {
  const managed = Boolean(env[MATE_ENV.guidanceJson]?.trim()) && !runsInSharedService(argv);
  return managed ? env : {};
}
