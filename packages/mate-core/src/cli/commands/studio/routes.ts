/** Default bind stays loopback because payloads carry absolute paths and names. */
export const STUDIO_HOSTNAME = "127.0.0.1";

/** A folder's entries as an HTML fragment, fetched when the viewer first expands it. */
export const VAULT_DIR_ROUTE = "/api/vault/dir";
/** Name-filter matches over the whole listed tree, as an HTML fragment. */
export const VAULT_FILTER_ROUTE = "/api/vault/filter";
/** Server-sent listing generations: a newer one marks the displayed tree stale. */
export const VAULT_CHANGES_ROUTE = "/api/vault/changes";
