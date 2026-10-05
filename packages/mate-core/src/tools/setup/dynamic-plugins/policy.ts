/** Environment variable carrying the appliance's declared-plugin package allowlist. */
export const ALLOWED_PLUGINS_ENV = "MATE_ALLOWED_PLUGINS";

/**
 * Parsed allowlist: exact package names and scope-wide `@scope/*` patterns.
 * An empty list permits no package; the policy's absence permits all.
 */
export interface PluginPolicy {
  exact: string[];
  scopes: string[];
}

export class PluginPolicyError extends Error {}

const EXACT_PATTERN = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const SCOPE_PATTERN = /^@[a-z0-9][a-z0-9._~-]*\/\*$/;

/**
 * Parses a comma-separated allowlist. `undefined` means no policy; an empty
 * or blank string is an explicit empty policy. Malformed entries throw so a
 * typo can never widen or silently narrow the trust decision.
 */
export function parseAllowedPlugins(raw: string | undefined): PluginPolicy | null {
  if (raw === undefined) return null;
  const policy: PluginPolicy = { exact: [], scopes: [] };
  if (raw.trim() === "") return policy;
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (SCOPE_PATTERN.test(entry)) policy.scopes.push(entry.slice(0, entry.indexOf("/") + 1));
    else if (EXACT_PATTERN.test(entry)) policy.exact.push(entry);
    else {
      throw new PluginPolicyError(
        `${ALLOWED_PLUGINS_ENV}: malformed entry ${JSON.stringify(entry)}; expected an exact package name or a scope pattern such as "@acme/*"`,
      );
    }
  }
  return policy;
}

/** Reads the effective policy from an environment; throws on a malformed value. */
export function readPluginPolicy(
  env: Record<string, string | undefined> = process.env,
): PluginPolicy | null {
  return parseAllowedPlugins(env[ALLOWED_PLUGINS_ENV]);
}

export function isPluginAllowed(policy: PluginPolicy | null, packageName: string): boolean {
  if (policy === null) return true;
  if (policy.exact.includes(packageName)) return true;
  return policy.scopes.some((scope) => packageName.startsWith(scope));
}

export function disallowedPluginMessage(packageName: string): string {
  return `plugin "${packageName}" is not allowed by ${ALLOWED_PLUGINS_ENV}`;
}
