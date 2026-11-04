/** @jsxRuntime automatic */
/** @jsxImportSource react */
export const LAUNCH_TARGETS = ["claude", "opencode"] as const;
export type LaunchTarget = (typeof LAUNCH_TARGETS)[number];
