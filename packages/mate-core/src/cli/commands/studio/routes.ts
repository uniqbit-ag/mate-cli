/** Default bind stays loopback because payloads carry absolute paths and names. */
export const STUDIO_HOSTNAME = "127.0.0.1";

/** Server-sent changes to one open vault file. */
export const VAULT_EVENTS_ROUTE = "/api/vault/events";

/** `GET` lists a companion's hosted reports; `POST` publishes with a session credential. */
export const REPORTS_ROUTE = "/api/reports";
/** A hosted report's HTML is served at this prefix plus its id. */
export const REPORT_VIEW_PREFIX = "/studio/reports/";

/** A service plugin's routes: `/api/plugins/<service id>/…`. */
export const SERVICE_ROUTE_PREFIX = "/api/plugins/";

/** A service plugin's view modules: `/studio/plugins/<service id>/<view id>/<file>`. */
export const SERVICE_ASSET_PREFIX = "/studio/plugins/";

/** Answers 204 to any reader; the page probes its connection here. */
export const STUDIO_PING_ROUTE = "/api/ping";

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
