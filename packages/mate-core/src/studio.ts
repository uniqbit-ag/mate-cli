/**
 * What Studio's application (`@uniqbit/mate-studio`) may use from Mate Core: the
 * services contract it receives as request context and the view model types.
 */
export type {
  CompanionAddInput,
  CompanionAddResult,
  FrictionMarkResult,
  StudioRequestContext,
  StudioServices,
} from "./cli/commands/studio/services";
export type {
  StudioServiceSummary,
  StudioServiceViewSummary,
} from "./cli/commands/studio/service-host";
export type {
  StudioViewLayout,
  StudioViewMount,
  StudioViewMountContext,
} from "./tools/setup/service";
export {
  formatCollectedAt,
  healthNote,
  type StudioPage,
  type StudioReportSummary,
  type StudioVaultPage,
} from "./cli/commands/studio/views/model";
export type {
  StudioChange,
  StudioCompanionPayload,
  StudioShippedChange,
  StudioSpec,
  StudioSpecScope,
  StudioSubmittedChange,
  StudioWorkset,
} from "./cli/commands/studio/payload";
export { WORK_REQUEST_ACTIONS } from "./cli/commands/studio/work-requests";
// Types only: the module itself is server code.
export type {
  StudioWorkCard,
  StudioWorkPayload,
  StudioWorkTeam,
  WorkLaunchOffer,
  WorkRefusalKind,
  WorkRequest,
  WorkResult,
} from "./cli/commands/studio/work";
export {
  WORK_ACTIONS as WORK_CARD_ACTIONS,
  WORK_BUCKETS,
  type Claim,
  type Progress,
  type SharingFacts,
  type SyncState,
  type WorkActionId,
  type WorkBucket,
  type WorkMemberStatus,
} from "./lib/workset/projection";
export type { SharePreview } from "./lib/workset/sharing";
export {
  archivedArtifactPath,
  canonicalSpecPath,
  capabilityNodeId,
  GRAPH_ARTIFACTS,
  GRAPH_EDGE_KINDS,
  GRAPH_EDGE_STRIDE,
  ROOT_AREA_LABEL,
  type StudioGraphArchive,
  type StudioGraphEdgeKind,
  type StudioGraphNode,
  type StudioGraphNodeKind,
  type StudioSpecGraph,
} from "./cli/commands/studio/graph-model";

export {
  CHANGE_PLACEHOLDER,
  COMPANION_DIGEST_PATTERN,
  COMPANION_PARAM,
  companionDigest,
  effectiveMode,
  IDEA_PLACEHOLDER,
  LANDING_VIEW,
  LEGACY_ROLE_MODES,
  LEGACY_ROLE_PARAM,
  MODE_VIEWS,
  modePolicy,
  NODE_PARAM,
  openFile,
  openFolder,
  parse as parseSelection,
  requestedMode,
  resolveCompanion,
  SHARED_VIEWS,
  STUDIO_MODE_PARAM,
  STUDIO_MODES,
  STUDIO_PROFILES,
  switchCompanion,
  switchMode,
  switchView,
  toHref,
  VIEW_PARAM,
  viewsFor,
  type StudioMode,
  type StudioModePolicy,
  type StudioProfile,
  type StudioSelection,
  type StudioView,
} from "./cli/commands/studio/selection";
export {
  connectionStateOf,
  probeStudio,
  type StudioConnection,
  type StudioConnectionProblem,
  type StudioConnectionState,
} from "./cli/commands/studio/connection";
export { BRAND_SVGS } from "./brand/svg.generated";
export {
  REPORT_VIEW_PREFIX,
  SERVICE_ASSET_PREFIX,
  SERVICE_ROUTE_PREFIX,
  STUDIO_EVENTS_ROUTE,
  STUDIO_PING_ROUTE,
  TERMINAL_SESSIONS_END_ROUTE,
  TERMINAL_SESSIONS_ROUTE,
  TERMINAL_SOCKET_ROUTE,
  TERMINAL_WASM,
  type StudioEvent,
} from "./cli/commands/studio/routes";
export type { TerminalAgent } from "./cli/commands/studio/terminal";
export type {
  VaultEntry,
  VaultOpenFile,
  VaultView,
  VaultViewRequest,
} from "./cli/commands/studio/views/vault/view";
export type {
  MdAttributes,
  MdElement,
  MdNode,
  MdTag,
} from "./cli/commands/studio/views/vault/markdown-tree";
export { guideTree } from "./cli/commands/studio/views/vault/markdown-tree";
export type { VaultConflict, VaultSaved } from "./cli/commands/studio/vault";
export type { StudioInventory, StudioInventoryCompanion } from "./cli/commands/studio/inventory";
export type { StudioSkillInventory } from "./cli/commands/studio/mate-inventory";
export type { SkillAgent, SkillFileEntry, SkillPreview } from "./cli/commands/studio/skill-files";
export type { StoredReport } from "./cli/commands/studio/reports";
export {
  FRICTION_VIEW_DAYS,
  frictionViewDays,
  type FrictionFreeReport,
  type FrictionGroup,
  type FrictionGroupState,
  type FrictionItemState,
  type FrictionView,
  type FrictionViewDays,
} from "./lib/friction/view/model";
export type { FrictionReport } from "./runtime/friction-log";
export {
  selectFriction,
  type FrictionFilters,
  type FrictionShown,
} from "./lib/friction/view/select";
export {
  FRICTION_STATES,
  MARK_STATES,
  REPORT_KINDS,
  STATE_FILTERS,
  SUBJECT_TYPES,
  subjectTypeOf,
  type FrictionState,
  type FrictionStateName,
  type FrictionStateOrigin,
  type MarkState,
  type ReportKind,
  type StateFilter,
  type SubjectType,
} from "./runtime/friction-vocabulary";
export { FRAMEWORK_NAME } from "./runtime/framework";
export { formatCommand } from "./runtime/command-arg";
export type { UsageRequest } from "./lib/usage/cache";
export type {
  CompanionUsageSnapshot,
  UsageBreakdown,
  UsageCost,
  UsageCoverage,
  UsageDaily,
  UsageMetrics,
  UsageRepository,
  UsageResponse,
  UsageSource,
  UsageSourceName,
  UsageWindow,
} from "./lib/usage/types";
export {
  findAction,
  SUBJECT_PATTERN,
  specActionOffers,
  type SpecActionOffer,
} from "./cli/commands/studio/actions";
export { WORKSET_STAGE_ORDER, type WorksetStageId } from "./lib/workset/stage";
export {
  canonicalSchema,
  DEFAULT_SCHEMA,
  deliveryPath,
  isMateSchema,
  LEGACY_SCHEMA_ALIASES,
  SCHEMA_ARTIFACTS,
  SHIPPED_SCHEMAS,
  type DeliveryPath,
  type DeliveryStage,
  type MateSchema,
  type ReviewStage,
  type SkillStage,
  type SkillStageId,
} from "./lib/delivery/stages";
// The workflow model imports nothing, so the browser bundle can resolve a path with it.
export {
  BUILTIN_ARTIFACT_TYPE,
  defaultWorkflow,
  nextStage,
  WORKFLOW_FILE,
  type Milestone,
  type NextStage,
  type Workflow,
  type WorkflowProblem,
  type WorkflowReviewStage,
  type WorkflowSkillStage,
  type WorkflowStage,
  type WorkflowStep,
} from "./runtime/workflow/workflow";
export {
  pathPosition,
  stagesBeforeWork,
  stepStage,
  type PathPosition,
  type PathProgress,
  type PathSubject,
} from "./lib/workflow/position";
export type { Handoff, HandoffAction, SkillAction, TextAction } from "./lib/workflow/handoff";
export type { WorkflowTopology } from "./cli/commands/studio/topology";
export {
  contrastRatio,
  DARK_PALETTE,
  LIGHT_PALETTE,
  type ReportPalette,
} from "./cli/commands/report/palette";

export {
  McpManagerConflictError,
  readMcpManager,
  writeMcpManager,
  type McpManagerPatch,
  type McpManagerSnapshot,
} from "./lib/mcp-manager/store";
export type {
  McpManagerAudienceSelection,
  McpManagerConfig,
  McpManagerRemoteServer,
  McpManagerSelection,
  McpManagerServer,
  McpManagerStdioServer,
  McpManagerTransport,
} from "./lib/mcp-manager/types";
