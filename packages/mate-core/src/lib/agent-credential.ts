import fs from "node:fs";
import path from "node:path";

/**
 * An agent's Claude credential: an Anthropic API key or a Claude subscription
 * token, one set from Studio and kept in a user-only file, else one supplied at
 * startup. Nothing here returns the value except `current()`.
 */

export const AGENT_CREDENTIAL_NAMES = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;
export type AgentCredentialName = (typeof AGENT_CREDENTIAL_NAMES)[number];

export interface AgentCredential {
  name: AgentCredentialName;
  value: string;
}

/** A refused credential or store operation; the message never quotes a value. */
export class AgentCredentialError extends Error {
  override name = "AgentCredentialError";
}

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

export function credentialLabel(name: AgentCredentialName): string {
  return KINDS[credentialKind(name)].label;
}

export interface CredentialStatus {
  kind: CredentialKind | null;
  /** `login`: no credential set or supplied; the local Claude login answers. */
  source: "studio" | "startup" | "login" | null;
  /** When it was set in Studio, as an ISO date; null otherwise. */
  setAt: string | null;
}

/** Checks a value for its kind; the message never quotes the value. */
export function checkedCredential(kind: unknown, value: unknown): AgentCredential {
  if (typeof kind !== "string" || !CREDENTIAL_KINDS.includes(kind as CredentialKind)) {
    throw new AgentCredentialError(`kind must be one of ${CREDENTIAL_KINDS.join(", ")}`);
  }
  const expected = KINDS[kind as CredentialKind];
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new AgentCredentialError(`no ${expected.label} was given`);
  if (/\s/.test(text) || !text.startsWith(expected.prefix)) {
    throw new AgentCredentialError(
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

/** What an agent start reads; the attach socket needs nothing more. */
export interface AgentCredentials {
  current(): AgentCredential | null;
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

  /** The credential set in Studio only, ignoring the startup one. */
  studio(): AgentCredential | null {
    return this.stored;
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
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
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
    if (this.file === null) throw new AgentCredentialError("this store keeps no credential file");
    return this.file;
  }
}
