/**
 * Server-side building blocks for authoring OpenCode plugins: the companion
 * guidance hooks and the companion policy helpers. Session-runtime only —
 * modules here must not import framework internals (see the import-isolation
 * test). Must not reach OpenTUI or Solid: the Mate TUI plugin lives on the
 * `./opencode/tui` subpath.
 */
export {
  createReactDoctorScanner,
  guardToolInput,
  registerCompanionHooks,
  type CommandRunner,
  type CompanionHooksOptions,
} from "./companion-hooks";
export { resolveOpenCodeGuidance, type OpenCodeGuidanceResolution } from "./projected-guidance";
export * from "./companion-policy";
