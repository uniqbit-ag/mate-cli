/**
 * What Studio's application (`@uniqbit/mate-studio`) may use from Mate Core: the
 * services contract it receives as request context and the view model types.
 */
export type {
  CompanionAddInput,
  CompanionAddResult,
  StudioRequestContext,
  StudioServices,
} from "./cli/commands/studio/services";
export type {
  StudioServiceSummary,
  StudioServiceViewSummary,
} from "./cli/commands/studio/service-host";
export type { StudioViewMount, StudioViewMountContext } from "./tools/setup/service";
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
export { BRAND_SVGS } from "./brand/svg.generated";
export {
  REPORT_VIEW_PREFIX,
  SERVICE_ASSET_PREFIX,
  SERVICE_ROUTE_PREFIX,
  STUDIO_EVENTS_ROUTE,
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
  DEFAULT_SCHEMA,
  deliveryPath,
  isMateSchema,
  SCHEMA_ARTIFACTS,
  type DeliveryStage,
  type MateSchema,
  type SkillStageId,
} from "./lib/delivery/stages";
export type { WorkflowTopology } from "./cli/commands/studio/topology";
export {
  contrastRatio,
  DARK_PALETTE,
  LIGHT_PALETTE,
  type ReportPalette,
} from "./cli/commands/report/palette";
