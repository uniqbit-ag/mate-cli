/** Default bind stays loopback because payloads carry absolute paths and names. */
export const STUDIO_HOSTNAME = "127.0.0.1";

/** A folder's entries as an HTML fragment, fetched when the viewer first expands it. */
export const VAULT_DIR_ROUTE = "/api/vault/dir";
/** Name-filter matches over the whole listed tree, as an HTML fragment. */
export const VAULT_FILTER_ROUTE = "/api/vault/filter";
/** Server-sent listing generations: a newer one marks the displayed tree stale. */
export const VAULT_CHANGES_ROUTE = "/api/vault/changes";

/** `GET` lists a companion's hosted reports; `POST` publishes with a session credential. */
export const REPORTS_ROUTE = "/api/reports";
/** A hosted report's HTML is served at this prefix plus its id. */
export const REPORT_VIEW_PREFIX = "/studio/reports/";
