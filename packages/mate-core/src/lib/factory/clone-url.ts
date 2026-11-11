import { parseRemote } from "../delivery/forge";
import { FactoryError, hasSpaceOrControl } from "./ids";

/** A Git URL a person may ask the factory to clone: where it is, and what it names. */
export interface CloneUrl {
  url: string;
  host: string;
  /** `owner/repo`, the repository's identity on its host. */
  identity: string;
  /** The last path segment, which names a companion's folder. */
  name: string;
}

const SCHEMES = new Set(["http:", "https:", "ssh:"]);

/**
 * Accepts an HTTP(S) or SSH remote URL, or the scp form, that names an organization and a
 * repository. A local path, a `file` URL, an option-like value and a transport that runs a
 * command are refused, so a browser cannot point the factory at its own filesystem.
 */
export function checkedCloneUrl(value: unknown): CloneUrl {
  const url = typeof value === "string" ? value.trim() : "";
  if (!url) throw new FactoryError("no Git URL was given");
  if (url.startsWith("-") || hasSpaceOrControl(url)) {
    throw new FactoryError("a Git URL has no spaces, control characters or leading dash");
  }
  const scheme = /^([a-z][a-z\d+.-]*):\/\//i.exec(url)?.[1];
  if (scheme !== undefined && !SCHEMES.has(`${scheme.toLowerCase()}:`)) {
    throw new FactoryError("a Git URL starts with https://, http://, ssh:// or is user@host:path");
  }
  if (scheme === undefined && !/^(?:[^/\s@]+@)?[^/\s:]{2,}:[^:]/.test(url)) {
    throw new FactoryError("a Git URL starts with https://, http://, ssh:// or is user@host:path");
  }
  const repo = parseRemote(url);
  if (!repo) {
    throw new FactoryError("a Git URL names an organization and a repository, as in host/acme/web");
  }
  return { url, host: repo.host, identity: `${repo.owner}/${repo.repo}`, name: repo.repo };
}
