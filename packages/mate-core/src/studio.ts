/**
 * What Studio's application (`@uniqbit/mate-studio`) may use from Mate Core: the
 * services contract it receives as request context and the view model types.
 */
export type {
  StudioFormField,
  StudioRequestContext,
  StudioServices,
} from "./cli/commands/studio/services";
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
  StudioWorkset,
} from "./cli/commands/studio/payload";
export type { FactoryRunView } from "./lib/factory/outcomes/runs";

export {
  CHANGE_PLACEHOLDER,
  COMPANION_DIGEST_PATTERN,
  COMPANION_PARAM,
  companionDigest,
  IDEA_PLACEHOLDER,
  LANDING_VIEW,
  openFile,
  openFolder,
  parse as parseSelection,
  resolveCompanion,
  ROLE_PARAM,
  ROLE_VIEWS,
  SHARED_VIEWS,
  STUDIO_ROLES,
  switchCompanion,
  switchRole,
  switchView,
  toHref,
  VIEW_PARAM,
  viewsFor,
  type StudioRole,
  type StudioSelection,
  type StudioView,
} from "./cli/commands/studio/selection";
export { BRAND_SVGS } from "./brand/svg.generated";
export {
  FACTORY_CREDENTIAL_ROUTE,
  factoryLogRoute,
  factoryLogStreamRoute,
  REPORT_VIEW_PREFIX,
  STUDIO_EVENTS_ROUTE,
  TERMINAL_SESSIONS_END_ROUTE,
  TERMINAL_SESSIONS_ROUTE,
  TERMINAL_SOCKET_ROUTE,
  TERMINAL_WASM,
  type StudioEvent,
} from "./cli/commands/studio/routes";
export type { CredentialKind, CredentialStatus } from "./lib/factory/credential-store";
export { type AgentQuestion, questionsOf } from "./lib/factory/runner/questions";
export {
  isOutcomeAction,
  OUTCOME_ACTIONS,
  outcomeActions,
  outcomeRefusal,
  type OutcomeAction,
  type OutcomeCompanionFacts,
  type OutcomeFacts,
  type OutcomeRunFacts,
} from "./lib/factory/outcomes/actions";
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
export type { VaultConflict, VaultSaved } from "./cli/commands/studio/vault";
export type { StudioInventory, StudioInventoryCompanion } from "./cli/commands/studio/inventory";
export type { StudioSkillInventory } from "./cli/commands/studio/mate-inventory";
export {
  findAction,
  SUBJECT_PATTERN,
  specActionOffers,
  type SpecActionOffer,
} from "./cli/commands/studio/actions";
export { compareRanked, rankOf } from "./lib/factory/runner/rank";
export type { Situation } from "./lib/factory/runner/state";
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
