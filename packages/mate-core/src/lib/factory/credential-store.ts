import fs from "node:fs";
import path from "node:path";

import { FactoryError } from "./ids";

/**
 * The Workset agent credential the broker holds: one set from Studio, kept in a
 * root-only file in the factory state volume, else the one supplied at startup.
 * Nothing here returns the value except `current()`, which only the broker's
 * agent starts read.
 */

export const AGENT_CREDENTIAL_NAMES = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;
export type AgentCredentialName = (typeof AGENT_CREDENTIAL_NAMES)[number];

export interface AgentCredential {
  name: AgentCredentialName;
  value: string;
}

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

const CREDENTIAL_KINDS = ["subscription", "api-key"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

const KINDS: Record<CredentialKind, { name: AgentCredentialName; prefix: string; label: string }> =
  {
    subscription: {
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      prefix: "sk-ant-oat",
      label: "Claude subscription token",
    },
    "api-key": { name: "ANTHROPIC_API_KEY", prefix: "sk-ant-api", label: "Anthropic API key" },
  };

export function credentialKind(name: AgentCredentialName): CredentialKind {
  return name === "CLAUDE_CODE_OAUTH_TOKEN" ? "subscription" : "api-key";
}

export interface CredentialStatus {
  kind: CredentialKind | null;
  source: "studio" | "startup" | null;
  /** When it was set in Studio, as an ISO date; null for a startup credential. */
  setAt: string | null;
}

/** What an agent start reads; the attach socket needs nothing more. */
export interface AgentCredentials {
  current(): AgentCredential | null;
}

/** Checks a value for its kind; the message never quotes the value. */
export function checkedCredential(kind: unknown, value: unknown): AgentCredential {
  if (typeof kind !== "string" || !CREDENTIAL_KINDS.includes(kind as CredentialKind)) {
    throw new FactoryError(`kind must be one of ${CREDENTIAL_KINDS.join(", ")}`);
  }
  const expected = KINDS[kind as CredentialKind];
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new FactoryError(`no ${expected.label} was given`);
  if (/\s/.test(text) || !text.startsWith(expected.prefix)) {
    throw new FactoryError(
      `${expected.label}s start with ${expected.prefix} and have no spaces; nothing was stored`,
    );
  }
  return { name: expected.name, value: text };
}

function parse(text: string): AgentCredential | null {
  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");
    const name = line.slice(0, separator) as AgentCredentialName;
    if (separator > 0 && AGENT_CREDENTIAL_NAMES.includes(name)) {
      const value = line.slice(separator + 1).trim();
      if (value) return { name, value };
    }
  }
  return null;
}

export class CredentialStore implements AgentCredentials {
  private stored: AgentCredential | null = null;
  private setAt: Date | null = null;

  /** `file` null keeps nothing on disk and refuses set and clear. */
  constructor(
    private readonly file: string | null,
    private readonly startup: AgentCredential | null,
  ) {
    if (file === null) return;
    try {
      this.stored = parse(fs.readFileSync(file, "utf8"));
      this.setAt = this.stored ? fs.statSync(file).mtime : null;
    } catch {
      this.stored = null;
    }
  }

  current(): AgentCredential | null {
    return this.stored ?? this.startup;
  }

  status(): CredentialStatus {
    if (this.stored) {
      return {
        kind: credentialKind(this.stored.name),
        source: "studio",
        setAt: this.setAt?.toISOString() ?? null,
      };
    }
    if (this.startup) {
      return { kind: credentialKind(this.startup.name), source: "startup", setAt: null };
    }
    return { kind: null, source: null, setAt: null };
  }

  set(credential: AgentCredential): void {
    const file = this.writable();
    const temp = path.join(path.dirname(file), `.${CREDENTIAL_FILE}.${process.pid}.tmp`);
    fs.writeFileSync(temp, `${credential.name}=${credential.value}\n`, { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
    this.stored = credential;
    this.setAt = fs.statSync(file).mtime;
  }

  clear(): void {
    fs.rmSync(this.writable(), { force: true });
    this.stored = null;
    this.setAt = null;
  }

  private writable(): string {
    if (this.file === null) throw new FactoryError("the broker keeps no credential file");
    return this.file;
  }
}
