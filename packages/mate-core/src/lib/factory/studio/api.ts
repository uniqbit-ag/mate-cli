/**
 * What Studio's Factory view (still compiled into `@uniqbit/mate-studio`) uses from the
 * factory: its routes and the view model types. Moves with the factory into its own package.
 */
export type { FactoryRunView } from "../outcomes/runs";
export type { CredentialKind, CredentialStatus } from "../credential-store";
export type { GitTokenStatus } from "../git-credential-store";
export { type AgentQuestion, questionsOf } from "../runner/questions";
export {
  isOutcomeAction,
  OUTCOME_ACTIONS,
  outcomeActions,
  outcomeRefusal,
  type OutcomeAction,
  type OutcomeCompanionFacts,
  type OutcomeFacts,
  type OutcomeRunFacts,
} from "../outcomes/actions";
export { compareRanked, rankOf } from "../runner/rank";
export type { Situation } from "../runner/state";
export type { RepositoryAddInput, RepositoryAddResult } from "./repository-add";
export {
  FACTORY_ACTION_ROUTE,
  FACTORY_BOARD_ROUTE,
  FACTORY_CREDENTIAL_ROUTE,
  FACTORY_GIT_TOKENS_ROUTE,
  FACTORY_REPOSITORIES_ROUTE,
  FACTORY_SERVICE_ID,
  factoryLogRoute,
  factoryLogStreamRoute,
} from "./routes";
