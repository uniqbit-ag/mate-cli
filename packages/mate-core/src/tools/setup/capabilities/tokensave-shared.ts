export const TOKENSAVE_WORKING_REPO_EXCLUDE_ENTRIES = [".tokensave/"];

// Marker that identifies the tokensave installer's CLAUDE.md append block.
// Declared here (capability-owned) and consumed by the Claude Runtime Surface
// when reconciling working-repo files at launch.
export const TOKENSAVE_CLAUDE_MD_MARKER =
  "## MANDATORY: No Explore Agents When Tokensave Is Available";
