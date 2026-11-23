/**
 * A companion's workflow declaration, `.mate/config/workflow.yaml`. Implemented under `runtime/`,
 * because session guidance and the session banner read it without a launch and may not import
 * `lib/`.
 */
export * from "../../runtime/workflow/declaration";
