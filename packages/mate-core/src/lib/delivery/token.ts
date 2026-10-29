import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The only environment variable a forge token is read from. */
export const FORGE_TOKEN_ENV = "MATE_GIT_TOKEN";

export interface ForgeToken {
  token: string;
  source: typeof FORGE_TOKEN_ENV | "gh";
}

export interface ForgeTokenDeps {
  env?: Record<string, string | undefined>;
  /** `gh auth token`, or null when the GitHub CLI is missing or signed out. */
  ghToken?: () => Promise<string | null>;
}

/** Variables `gh auth token` would report instead of the stored login. */
const GH_TOKEN_VARIABLES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

/** `env` without the token variables, so `gh` reports only its stored login. */
export function ghAuthEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed = { ...env };
  for (const name of GH_TOKEN_VARIABLES) delete scrubbed[name];
  return scrubbed;
}

async function defaultGhToken(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      timeout: 10_000,
      env: ghAuthEnv(process.env),
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The forge token from `MATE_GIT_TOKEN`, then `gh auth token`. Other variables such as
 * `GITHUB_TOKEN` are deliberately ignored so a broadly scoped CI token is never picked up.
 * The returned value is for the forge request only: callers never print, log, or store it.
 */
export async function resolveForgeToken(deps: ForgeTokenDeps = {}): Promise<ForgeToken | null> {
  const env = deps.env ?? process.env;
  const fromEnv = env[FORGE_TOKEN_ENV]?.trim();
  if (fromEnv) return { token: fromEnv, source: FORGE_TOKEN_ENV };
  const fromGh = (await (deps.ghToken ?? defaultGhToken)())?.trim();
  return fromGh ? { token: fromGh, source: "gh" } : null;
}
