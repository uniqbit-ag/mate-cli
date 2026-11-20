import { AGENT_CREDENTIAL_NAMES, type AgentCredential } from "../agent-credential";

/**
 * The Workset agent credential the broker holds: one set from Studio, kept in a
 * root-only file in the factory state volume, else the one supplied at startup.
 * The kinds, check and store are shared with Studio Chat.
 */

export {
  AGENT_CREDENTIAL_NAMES,
  type AgentCredential,
  type AgentCredentialName,
  type AgentCredentials,
  checkedCredential,
  credentialKind,
  type CredentialKind,
  type CredentialStatus,
  CredentialStore,
} from "../agent-credential";

/**
 * Takes the startup credential out of the process environment so no child — Git
 * runs as the unprivileged user — inherits it.
 */
export function takeAgentCredential(env: NodeJS.ProcessEnv = process.env): AgentCredential | null {
  let credential: AgentCredential | null = null;
  for (const name of AGENT_CREDENTIAL_NAMES) {
    const value = env[name];
    delete env[name];
    if (value && credential === null) credential = { name, value };
  }
  return credential;
}

export const NO_CREDENTIAL =
  "no Workset agent credential is configured; set one in the Factory view's Agents panel, or supply CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY at startup";

export const CREDENTIAL_FILE = "agent-credential.env";
