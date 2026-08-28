/**
 * Framework identity: names everything identity-shaped — state directories
 * (`~/.mate`, `.mate/`), managed-block markers, `MATE_*` env values, usage
 * output, command hints, error prefixes, agent guidance, and permission
 * entries. The distribution is always invoked as `mate`.
 *
 * Lives under `runtime/` because the import-isolated runtime subpath derives
 * repo-local `.mate/` paths from it; `../framework` re-exports it.
 */
export const FRAMEWORK_NAME = "mate";
