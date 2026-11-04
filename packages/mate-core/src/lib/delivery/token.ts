/** The only environment variable a forge token is read from. */
export const FORGE_TOKEN_ENV = "MATE_GIT_TOKEN";

export interface ForgeToken {
  token: string;
  source: typeof FORGE_TOKEN_ENV;
}

export interface ForgeTokenDeps {
  env?: Record<string, string | undefined>;
}

/**
 * The forge token from `MATE_GIT_TOKEN`, or null. Other variables such as `GITHUB_TOKEN`
 * are deliberately ignored so a broadly scoped CI token is never picked up. No stored
 * credential (GitHub CLI, keychain, Git credential helper) is ever read: endpoint security
 * reports that as credential access. The returned value is for the forge request only:
 * callers never print, log, or store it.
 */
export async function resolveForgeToken(deps: ForgeTokenDeps = {}): Promise<ForgeToken | null> {
  const env = deps.env ?? process.env;
  const fromEnv = env[FORGE_TOKEN_ENV]?.trim();
  return fromEnv ? { token: fromEnv, source: FORGE_TOKEN_ENV } : null;
}
