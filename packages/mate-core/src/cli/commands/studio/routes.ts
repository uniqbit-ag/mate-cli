/** Default bind stays loopback because payloads carry absolute paths and names. */
export const STUDIO_HOSTNAME = "127.0.0.1";

/** Server-sent changes to one open vault file. */
export const VAULT_EVENTS_ROUTE = "/api/vault/events";

/** `GET` lists a companion's hosted reports; `POST` publishes with a session credential. */
export const REPORTS_ROUTE = "/api/reports";
/** A hosted report's HTML is served at this prefix plus its id. */
export const REPORT_VIEW_PREFIX = "/studio/reports/";

/** Prefix of a Workset's run log routes. */
export const FACTORY_WORKSETS_ROUTE = "/api/factory/worksets";

/**
 * The Agents panel: `GET` the Workset agent credential's status, `PUT` `{kind, value}`
 * to set it, `DELETE` to clear one set in Studio. Factory mode only.
 */
export const FACTORY_CREDENTIAL_ROUTE = "/api/factory/credential";

/**
 * The Git access panel: `GET` the Git tokens' keys with their source and date, `PUT`
 * `{key, token}` to set one, `DELETE` `{key}` to clear one set in Studio. Factory mode only.
 */
export const FACTORY_GIT_TOKENS_ROUTE = "/api/factory/git-tokens";

/** `GET` a Workset's bounded run log as text. */
export function factoryLogRoute(id: string): string {
  return `${FACTORY_WORKSETS_ROUTE}/${encodeURIComponent(id)}/log`;
}

/** Server-sent events: a Workset's run log replayed, then followed live. */
export function factoryLogStreamRoute(id: string): string {
  return `${factoryLogRoute(id)}/stream`;
}

/** One event stream per page: board, reports and markdown tree changes for a companion. */
export const STUDIO_EVENTS_ROUTE = "/api/events";

/** What changed for one companion: its board, its hosted reports, or its markdown tree. */
export type StudioEvent =
  | { type: "board" }
  | { type: "reports"; id: string; title: string }
  | { type: "vault-tree"; generation: number };

/** Route prefix for the terminal client; served only when the terminal is enabled. */
export const TERMINAL_ASSET_PREFIX = "/studio/terminal/";

/** The terminal's WASM core, loaded by Studio's bundled terminal from Studio itself. */
export const TERMINAL_WASM = `${TERMINAL_ASSET_PREFIX}wterm.wasm`;

/** The terminal's WebSocket, and its session list and end calls. */
export const TERMINAL_SOCKET_ROUTE = "/api/terminal";
export const TERMINAL_SESSIONS_ROUTE = "/api/terminal/sessions";
export const TERMINAL_SESSIONS_END_ROUTE = "/api/terminal/sessions/end";
