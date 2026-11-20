import { parseRemote } from "./delivery/remote";

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
