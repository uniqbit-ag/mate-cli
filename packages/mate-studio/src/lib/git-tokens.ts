import { FACTORY_GIT_TOKENS_ROUTE, type GitTokenStatus } from "@uniqbit/mate-core/studio";

import { call } from "./agent-credential";

/**
 * The Git access panel's calls to the Git token route. Only each key's status is cached; an
 * entered token goes in one request body and is never kept, keyed or put in an address.
 */

export const gitTokensKey = ["git-tokens"] as const;

export interface GitTokens {
  tokens: GitTokenStatus[];
}

export const gitTokensQuery = () => ({
  queryKey: gitTokensKey,
  queryFn: () => call<GitTokens>("GET", FACTORY_GIT_TOKENS_ROUTE),
});

export const setGitToken = (key: string, token: string) =>
  call<GitTokens>("PUT", FACTORY_GIT_TOKENS_ROUTE, { key, token });

export const clearGitToken = (key: string) =>
  call<GitTokens>("DELETE", FACTORY_GIT_TOKENS_ROUTE, { key });

/** The host of a `host` or `host/org` key. */
export const hostOf = (key: string): string => key.split("/")[0]!;

/** Whether a stored key covers `key` (`host/org`): its own, or its host's. */
export const tokenCovers = (key: string, tokens: GitTokenStatus[]): boolean =>
  tokens.some((token) => token.key === key || token.key === hostOf(key));
