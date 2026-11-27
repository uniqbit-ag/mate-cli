import path from "node:path";

import { mateHome } from "../../runtime/runtime-directory";
import {
  type AgentCredential,
  AgentCredentialError,
  type CredentialStatus,
  CredentialStore,
} from "../agent-credential";
import { CHAT_NO_CREDENTIAL } from "./agent";

/**
 * Studio Chat's Claude credential. Sources, first wins: one set in Studio, kept in
 * `<mate home>/studio-chat/credential.env`; `ANTHROPIC_API_KEY`, then `CLAUDE_CODE_OAUTH_TOKEN`
 * in Studio's environment (left in place: the appliance's agent sessions inherit them); and on a
 * standard Studio only, the local `claude` login.
 * The appliance takes an Anthropic API key only: Anthropic's terms keep subscription credentials
 * out of a hosted agent product.
 */

/** Order differs from the factory's: an API key is the unambiguous choice under Anthropic's terms. */
const STARTUP_NAMES = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
const APPLIANCE_NAMES = ["ANTHROPIC_API_KEY"] as const;

export const NO_CHAT_CREDENTIAL = `${CHAT_NO_CREDENTIAL}. Set one under Credential in the session panel, or supply ANTHROPIC_API_KEY through credentials:.`;

/**
 * What a turn authenticates with: an explicit credential handed to the harness alone, `login`
 * to let the harness resolve the host's (standard profile only), or none.
 */
export type ChatAuth = AgentCredential | "login" | null;

export interface ChatCredentials {
  auth(): ChatAuth;
  status(): CredentialStatus;
  set(credential: AgentCredential): void;
  clear(): void;
}

export function chatCredentialFile(home: string = mateHome()): string {
  return path.join(home, "studio-chat", "credential.env");
}

function startupCredential(
  env: NodeJS.ProcessEnv,
  names: readonly AgentCredential["name"][],
): AgentCredential | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return { name, value };
  }
  return null;
}

export function createChatCredentials(
  options: {
    /** The appliance takes an API key only and never falls back to a login in the container. */
    appliance?: boolean;
    file?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): ChatCredentials {
  const appliance = options.appliance === true;
  const startup = startupCredential(
    options.env ?? process.env,
    appliance ? APPLIANCE_NAMES : STARTUP_NAMES,
  );
  const store = new CredentialStore(options.file ?? chatCredentialFile(), startup);
  // A subscription token set before the appliance took API keys only is removed, never used.
  const studio = store.studio();
  if (appliance && studio && studio.name !== "ANTHROPIC_API_KEY") store.clear();
  return {
    auth() {
      // The one the status names; a standard Studio with none lets the harness find the login.
      return store.current() ?? (appliance ? null : "login");
    },
    status() {
      const status = store.status();
      if (status.source === null && !appliance) return { ...status, source: "login" };
      return status;
    },
    set(credential) {
      if (appliance && credential.name !== "ANTHROPIC_API_KEY") {
        throw new AgentCredentialError(
          "the appliance takes an Anthropic API key only; nothing was stored",
        );
      }
      store.set(credential);
    },
    clear: () => store.clear(),
  };
}
