import fs from "node:fs";
import path from "node:path";

import { parseRemote } from "../delivery/forge";
import { FactoryError, hasSpaceOrControl } from "./ids";

/**
 * The Git tokens the broker holds, per host or per host and organization: those set from
 * Studio, kept in a root-only file in the factory state volume, and the startup token, which
 * covers only the hosts the operator named. Nothing here returns a token except `forUrl`,
 * which only the broker's own Git commands read.
 */

export const GIT_CREDENTIAL_FILE = "git-credentials.json";

/** The startup token and the variable naming the hosts it may be used for. */
export const GIT_STARTUP_TOKEN_ENV = "MATE_GIT_CLONE_TOKEN";
export const GIT_STARTUP_HOSTS_ENV = "MATE_FACTORY_GIT_TOKEN_HOSTS";

const MAX_TOKEN_LENGTH = 1024;
const KEY = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(\/[a-z0-9._-]+)?$/;

export interface GitTokenStatus {
  /** `host` or `host/org`. */
  key: string;
  source: "studio" | "startup";
  /** When it was set in Studio, as an ISO date; null for a startup token. */
  setAt: string | null;
}

export interface GitStartupToken {
  token: string;
  /** Lowercase hosts the token may be used for. */
  hosts: string[];
}

/** What a Git command reads: the token for a URL, or null when none applies. */
export interface GitCredentials {
  forUrl(url: string): string | null;
}

/** The host and the first path segment of a forge URL; null when it names neither. */
export function gitKeyOf(url: string): { host: string; org: string } | null {
  const repo = parseRemote(url);
  const org = repo?.owner.split("/")[0]?.toLowerCase();
  return repo && org ? { host: repo.host, org } : null;
}

/** The `host/org` key a token applies to for a clone URL; null for SSH and other non-HTTP(S) URLs. */
export function gitTokenKeyOf(url: string): string | null {
  if (!/^https?:\/\//i.test(url.trim())) return null;
  const key = gitKeyOf(url);
  return key ? `${key.host}/${key.org}` : null;
}

/** A key as stored: lowercase `host` or `host/org`. */
export function checkedGitKey(value: unknown): string {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!key) throw new FactoryError("no host was given for the Git token");
  if (!KEY.test(key)) {
    throw new FactoryError(
      "a Git token key is a host such as git.acme.test, or a host and one organization such as git.acme.test/acme; nothing was stored",
    );
  }
  return key;
}

/** A token as stored; the message never quotes it. */
export function checkedGitToken(value: unknown): string {
  const token = typeof value === "string" ? value.trim() : "";
  if (!token) throw new FactoryError("no Git token was given");
  if (token.length > MAX_TOKEN_LENGTH || hasSpaceOrControl(token)) {
    throw new FactoryError(
      `a Git token has no spaces or control characters and is at most ${MAX_TOKEN_LENGTH} characters; nothing was stored`,
    );
  }
  return token;
}

/**
 * Takes the startup token out of the process environment so no child inherits it; it is
 * usable only for the hosts the supervisor lists.
 */
export function takeGitStartupToken(env: NodeJS.ProcessEnv = process.env): GitStartupToken | null {
  const token = env[GIT_STARTUP_TOKEN_ENV]?.trim();
  const hosts = (env[GIT_STARTUP_HOSTS_ENV] ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  delete env[GIT_STARTUP_TOKEN_ENV];
  delete env[GIT_STARTUP_HOSTS_ENV];
  return token && hosts.length > 0 ? { token, hosts } : null;
}

interface Stored {
  token: string;
  setAt: string;
}

function parse(text: string): Map<string, Stored> {
  const entries = new Map<string, Stored>();
  const data: unknown = JSON.parse(text);
  if (data === null || typeof data !== "object" || Array.isArray(data)) return entries;
  for (const [name, entry] of Object.entries(data)) {
    const value = entry as Partial<Stored> | null;
    if (typeof value?.token !== "string" || typeof value.setAt !== "string") continue;
    try {
      entries.set(checkedGitKey(name), { token: value.token, setAt: value.setAt });
    } catch {
      /** A key that no longer validates is dropped. */
    }
  }
  return entries;
}

export class GitCredentialStore implements GitCredentials {
  private stored = new Map<string, Stored>();

  /** `file` null keeps nothing on disk and refuses set and clear. */
  constructor(
    private readonly file: string | null,
    private readonly startup: GitStartupToken | null,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (file === null) return;
    try {
      this.stored = parse(fs.readFileSync(file, "utf8"));
    } catch {
      this.stored = new Map();
    }
  }

  forUrl(url: string): string | null {
    const key = gitTokenKeyOf(url);
    if (!key) return null;
    const host = key.split("/")[0]!;
    const entry = this.stored.get(key) ?? this.stored.get(host);
    if (entry) return entry.token;
    return this.startup?.hosts.includes(host) ? this.startup.token : null;
  }

  status(): GitTokenStatus[] {
    const stored = [...this.stored].map(([key, entry]): GitTokenStatus => ({
      key,
      source: "studio",
      setAt: entry.setAt,
    }));
    const startup = (this.startup?.hosts ?? [])
      .filter((host) => !this.stored.has(host))
      .map((host): GitTokenStatus => ({ key: host, source: "startup", setAt: null }));
    return [...stored, ...startup].toSorted((a, b) => a.key.localeCompare(b.key));
  }

  set(key: string, token: string): void {
    const file = this.writable();
    const next = new Map(this.stored).set(key, { token, setAt: this.now().toISOString() });
    this.write(file, next);
    this.stored = next;
  }

  /** Removes a stored key; a key never stored is not an error. */
  clear(key: string): void {
    const file = this.writable();
    const next = new Map(this.stored);
    next.delete(key);
    this.write(file, next);
    this.stored = next;
  }

  private write(file: string, entries: Map<string, Stored>): void {
    const temp = path.join(path.dirname(file), `.${GIT_CREDENTIAL_FILE}.${process.pid}.tmp`);
    fs.writeFileSync(temp, JSON.stringify(Object.fromEntries(entries)), { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  }

  private writable(): string {
    if (this.file === null) throw new FactoryError("the broker keeps no Git token file");
    return this.file;
  }
}
