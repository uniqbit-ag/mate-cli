/**
 * Builtin plugin factories. Exported for distributions to pick from —
 * importing this module never registers anything; each factory returns a
 * fresh plugin instance, and registration happens only through the entries a
 * distribution passes to `createMate`.
 */
export { createClaudePlugin } from "./tools/setup/providers/claude";
export { createOpenCodePlugin } from "./tools/setup/providers/opencode";
export { createBunPlugin } from "./tools/setup/package-managers/bun";
export { createUvPlugin } from "./tools/setup/package-managers/uv";
export { createOpenspecPlugin } from "./tools/setup/capabilities/openspec";
export { createReactDoctorPlugin } from "./tools/setup/capabilities/react-doctor";
export { createTokensavePlugin } from "./tools/setup/capabilities/tokensave";
export { createHeadroomPlugin } from "./tools/setup/capabilities/headroom";
export { createGraphifyPlugin } from "./tools/setup/capabilities/graphify";
export { createGitignorePlugin } from "./tools/setup/plugins/gitignore";
