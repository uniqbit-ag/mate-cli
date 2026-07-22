/**
 * Building blocks for authoring OpenCode plugins: the Mate TUI plugin, the
 * companion guidance hooks, and the companion policy helpers. Session-runtime
 * only — modules here must not import framework internals (see the
 * import-isolation test).
 */
export { default as tuiPlugin } from "./tui";
export { CompanionHooksPlugin } from "./companion-hooks";
export * from "./companion-policy";
