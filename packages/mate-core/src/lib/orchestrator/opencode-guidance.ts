/**
 * The OpenCode guidance payload. Built in `runtime/` so the plugin can build
 * the same payload from the Projection Root when no launch injected one; this
 * module stays as the orchestrator-side name the launch adapter imports.
 */
export { buildOpenCodeGuidance } from "../../runtime/companion-guidance";
