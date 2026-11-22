/** The factory service's id: its routes are served below `/api/plugins/factory/`. */
export const FACTORY_SERVICE_ID = "factory";

const BASE = `/api/plugins/${FACTORY_SERVICE_ID}`;

/** `GET ?companion=<digest>`: the board's runs and the Worksets' open terminal sessions. */
export const FACTORY_BOARD_ROUTE = `${BASE}/board`;

/** `POST {companion, action, id?, fields}`: one Outcome action, or `create`. */
export const FACTORY_ACTION_ROUTE = `${BASE}/action`;

/** `POST {companion, input}` adds a Working Repository; `DELETE {companion, identity}` removes one. */
export const FACTORY_REPOSITORIES_ROUTE = `${BASE}/repositories`;

/**
 * The Agents panel: `GET` the Workset agent credential's status, `PUT` `{kind, value}`
 * to set it, `DELETE` to clear one set in Studio.
 */
export const FACTORY_CREDENTIAL_ROUTE = `${BASE}/credential`;

/**
 * The Git access panel: `GET` the Git tokens' keys with their source and date, `PUT`
 * `{key, token}` to set one, `DELETE` `{key}` to clear one set in Studio.
 */
export const FACTORY_GIT_TOKENS_ROUTE = `${BASE}/git-tokens`;

/** Prefix of a Workset's run log routes. */
export const FACTORY_WORKSETS_ROUTE = `${BASE}/worksets`;

/** `GET` a Workset's bounded run log as text. */
export function factoryLogRoute(id: string): string {
  return `${FACTORY_WORKSETS_ROUTE}/${encodeURIComponent(id)}/log`;
}

/** Server-sent events: a Workset's run log replayed, then followed live. */
export function factoryLogStreamRoute(id: string): string {
  return `${factoryLogRoute(id)}/stream`;
}
