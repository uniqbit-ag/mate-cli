/**
 * Core runtime the Mate factory plugin (github.com/uniqbit-ag/mate-factory) uses:
 * Worksets, Delivery records, companion config and Studio's server for its tests.
 *
 * Not a stable API. The factory pins mate-core exactly and must share the running
 * core's module instance: its distribution imports this entry from the same
 * `node_modules` tree as `@uniqbit/mate-core` itself, never from a second copy.
 */
export { usage } from "./cli/usage";
export { readCompanionWorksetStages } from "./cli/commands/studio/payload";
export type { StudioCompanionPayload, StudioWorkset } from "./cli/commands/studio/payload";
export { companionDigest } from "./cli/commands/studio/selection";
export { createStudioAccess } from "./cli/commands/studio/access";
export { createStudioFetch } from "./cli/commands/studio/server";
export { LiveSessions } from "./cli/commands/studio/live-sessions";
export { activeChanges, changesDirOf } from "./lib/change-layout";
export { companionTicketFormat, TICKETS_OFF, workingRepoGit } from "./lib/delivery/branches";
export { deliveryCheckout } from "./lib/delivery/checkout";
export { declaredDependencies } from "./lib/delivery/overlap";
export {
  defaultDeliveryBranch,
  findDelivery,
  readDeliveryRecord,
  sameRepository,
  unlinkedRecord,
  upsertDelivery,
  writeDeliveryRecord,
} from "./lib/delivery/record";
export { parseRemote } from "./lib/delivery/remote";
export {
  newBranchBase,
  resolveDeliveryBranch,
  worktreeAddArgs,
} from "./lib/delivery/resolve-branch";
export { groupOfChange, hasUnsubmittedWork, submissionState } from "./lib/delivery/staging/submit";
export { pathIsDirectory } from "./lib/fs-utils";
export { gitKeyOf, gitTokenKeyOf } from "./lib/git-key";
export { KeyedSerial } from "./lib/keyed-serial";
export { scopedRepositories } from "./lib/openspec-scopes";
export { mateSessionEnvironment } from "./lib/orchestrator/adapters/base";
export { readCompanionConfig } from "./lib/orchestrator/config-store";
export type { FrameworkConfig } from "./lib/orchestrator/types";
export {
  addLocalRepository,
  readLocalRepositories,
  removeLocalRepository,
} from "./lib/workset/factory-local";
export {
  advanceWorkset,
  createOutcome,
  findWorkset,
  isRepositoryIdentity,
  isWorksetId,
  readWorksets,
  removeWorkset,
  resolveWorksetBranch,
  setWorksetStarted,
  WorksetError,
  writeWorkset,
  type WorksetRecord,
} from "./lib/workset/record";
export { linkedRepositoryIdentities, repositorySources } from "./lib/workset/repositories";
export type { WorksetStageId } from "./lib/workset/stage";
export { readWorksetStages, type WorksetWithStage } from "./lib/workset/stages";
export { buildCompanionGuidance } from "./playbooks/companion-guidance";
export { errorMessage } from "./runtime/error-message";
export { resolveSecretPolicy } from "./runtime/policy";
export { deployReactDoctorSkill } from "./tools/setup/capabilities/react-doctor";
export { applyMateSkills, MATE_SKILLS } from "./tools/setup/mate";
