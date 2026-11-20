import type { FactoryClient } from "../../../lib/factory/client";
import { NO_CREDENTIAL } from "../../../lib/factory/credential-store";
import { createOutcomeFrom, type Outcomes } from "../../../lib/factory/outcomes";
import type { FactoryRunView } from "../../../lib/factory/outcomes/runs";
import type { Operator } from "../../../lib/workset/claims";
import { findEntry, ownershipFacts, startRefusal } from "../../../lib/workset/execution";
import {
  configuredOperator,
  type GitFailure,
  isGitBacked,
  workGit,
} from "../../../lib/workset/git-transaction";
import {
  activeMembers,
  type InventoryWorkset,
  readWorkInventory,
} from "../../../lib/workset/inventory";
import {
  FACTORY_WORK_ACTIONS,
  type FactoryAvailability,
  isActiveRun,
  LOCAL_ONLY,
  projectWorkCard,
  type WorkActionId,
  type WorkCard,
  type WorkContext,
  type WorkFacts,
  type WorkMemberStatus,
  type WorkRunState,
  workActionRefusal,
} from "../../../lib/workset/projection";
import { branchProbe } from "../../../lib/workset/repositories";
import { deriveWorksetStage, type WorksetStageId } from "../../../lib/workset/stage";
import { collectChangeFacts } from "../../../lib/workset/stages";
import {
  confirmShare,
  previewShare,
  readTeamBacklog,
  refreshTeam,
  remoteOnlyEntries,
  type SharePreview,
  type TeamStatus,
} from "../../../lib/workset/sharing";
import { sameMembers, updateClaim } from "../../../lib/workset/transactions";
import { pendingSubmittedChanges } from "../../../runtime/pending-records";
import { WORK_ACTIONS, skillInstalledFor } from "./actions";
import type { StudioSkillInventory } from "./mate-inventory";
import type { StudioChange, StudioShippedChange } from "./payload";
import type { TerminalAgent } from "./terminal";

/**
 * Studio's Work surface on the server: the payload the Work view reads and the one action
 * entry point its server functions call. Every action rechecks write mode, the Workset,
 * whether it is the operator's own work and, for factory actions, factory mode and
 * availability; the browser's view of any of them is never trusted.
 */

export interface WorkLaunchOffer {
  action: string;
  subject: string;
  label: string;
  /** Prompts a person may copy; copying is not a guarded start. */
  prompts: Partial<Record<TerminalAgent, string>>;
  /** Agents a guarded Run may start in Studio's terminal. */
  runAgents: TerminalAgent[];
}

export interface StudioWorkCard extends WorkCard {
  title: string;
  intent: string;
  repositories: string[];
  implicit: boolean;
  /** Members a confirmation is bound to. */
  memberNames: string[];
  /** Companion-relative artifact paths per active member, for links into the Vault. */
  artifacts: Record<string, string[]>;
  offers: WorkLaunchOffer[];
  /** This installation's factory run, in factory mode only. */
  run?: WorkRunState;
  needsYou: boolean;
}

export interface StudioWorkTeam {
  remote?: string;
  branch?: string;
  fetchedAt?: string;
  stale: boolean;
  failure?: string;
}

export interface StudioWorkPayload {
  writable: boolean;
  factory: FactoryAvailability;
  operator: Operator | null;
  gitBacked: boolean;
  team: StudioWorkTeam;
  cards: StudioWorkCard[];
  /** Cards that need the person, for navigation counts. */
  needsYou: number;
  /** What Scratchpad's capture form may name: a repository, and a ticket only with Jira. */
  linkedRepositories: string[];
  ticketFormat: string;
  diagnostics: string[];
}

export interface WorkInput {
  changes: readonly StudioChange[];
  shipped: readonly StudioShippedChange[];
  runs: Record<string, FactoryRunView> | null;
  writable: boolean;
  factory: FactoryAvailability;
  skills?: StudioSkillInventory;
  /** Agents Studio's terminal may start for this companion; empty without one. */
  terminalAgents?: TerminalAgent[];
  linkedRepositories?: string[];
  ticketFormat?: string;
}

/** As the Factory view's attention rule: a decision, a problem, or a person's review turn. */
function needsPerson(card: WorkCard, run: FactoryRunView | undefined): boolean {
  if (card.done || card.bucket === "remote" || !run) return false;
  if (run.control?.mode === "manual") return true;
  if (run.state === "waiting" || run.state === "failed" || run.state === "interrupted") return true;
  if (run.state === "queued" || run.state === "running") return false;
  return ["human-review", "merge-wait", "publish"].includes(card.stage);
}

function teamOf(status: TeamStatus): StudioWorkTeam {
  return {
    ...(status.shared ? { remote: status.shared.remote, branch: status.shared.branch } : {}),
    ...(status.fetchedAt ? { fetchedAt: status.fetchedAt } : {}),
    stale: status.stale,
    ...(status.failure ? { failure: status.failure.message } : {}),
  };
}

const AGENTS: readonly TerminalAgent[] = ["claude", "opencode"];

/** The launch actions a stage calls for, each with its subject. */
function wantedOffers(
  entry: InventoryWorkset,
  stage: WorksetStageId,
): { id: string; subject: string }[] {
  const active = activeMembers(entry);
  if (active.length === 0) {
    const id = stage === "clarify-intent" ? "explore-workset" : "propose-workset";
    return [{ id, subject: entry.id }];
  }
  if (stage === "propose") return [{ id: "propose-workset", subject: entry.id }];
  if (stage === "human-review" || stage === "apply") {
    return active.map((change) => ({ id: "apply-change", subject: change }));
  }
  return [];
}

function offersFor(
  entry: InventoryWorkset,
  stage: WorksetStageId,
  input: WorkInput,
): WorkLaunchOffer[] {
  if (!input.skills) return [];
  return wantedOffers(entry, stage).flatMap(({ id, subject }) => {
    const action = WORK_ACTIONS.find((candidate) => candidate.id === id)!;
    const copy = AGENTS.filter((agent) => skillInstalledFor(input.skills!, action.skill, agent));
    if (copy.length === 0) return [];
    return [
      {
        action: action.id,
        subject,
        label: action.label,
        prompts: Object.fromEntries(copy.map((agent) => [agent, action.prompts[agent](subject)])),
        runAgents: copy.filter((agent) => input.terminalAgents?.includes(agent)),
      },
    ];
  });
}

interface WorkModel {
  context: WorkContext;
  facts: Map<string, WorkFacts>;
  entries: Map<string, InventoryWorkset>;
  status: TeamStatus;
  diagnostics: string[];
}

/** Reads every fact Work projects from; reads local refs only and writes nothing. */
async function readWorkModel(
  companionPath: string,
  input: WorkInput,
  lastFailure?: GitFailure,
): Promise<WorkModel> {
  const git = workGit(companionPath);
  const gitBacked = await isGitBacked(git);
  const [inventory, backlog, operator, pending] = await Promise.all([
    readWorkInventory(companionPath),
    readTeamBacklog(companionPath, lastFailure),
    gitBacked ? configuredOperator(git) : Promise.resolve(null),
    gitBacked ? pendingSubmittedChanges(companionPath) : Promise.resolve([]),
  ]);
  const local = new Set(
    inventory.worksets.flatMap((entry) => entry.members.map((member) => member.name)),
  );
  const entries = [...inventory.worksets, ...remoteOnlyEntries(backlog, local)];
  const published = new Set(input.shipped.map((change) => change.anchor));
  const changeFacts = await collectChangeFacts(
    companionPath,
    entries.flatMap((entry) => entry.members),
    input.changes,
    published,
    undefined,
    new Set(pending.map((change) => change.name)),
  );
  const branchHere = branchProbe(companionPath);
  const context: WorkContext = {
    writable: input.writable,
    ...(operator ? { operator } : {}),
    gitBacked,
    factory: input.factory,
  };
  const facts = new Map<string, WorkFacts>();
  await Promise.all(
    entries.map(async (entry) => {
      const stage = deriveWorksetStage(entry.record, entry.members, (name) =>
        changeFacts.get(name),
      );
      const ownership = gitBacked
        ? await ownershipFacts(companionPath, entry, backlog, operator ?? undefined, branchHere)
        : {
            sharing: LOCAL_ONLY,
            claim: { kind: "none" as const },
            progress: { kind: "none" as const },
          };
      const members: WorkMemberStatus[] = entry.members.map((member) => {
        const fact = changeFacts.get(member.name);
        const memberStage = fact
          ? deriveWorksetStage({ ...entry.record, changes: [member.name] }, [member], () => fact)
          : stage;
        return {
          name: member.name,
          stage: memberStage.stage,
          stageLabel: memberStage.label,
          delivered: memberStage.stage === "done",
          ...(member.kind === "missing" ? { problem: "neither active nor archived" } : {}),
          ...(member.kind === "conflict" ? { problem: "listed by another Workset" } : {}),
        };
      });
      const run = input.factory.mode ? input.runs?.[entry.id] : undefined;
      facts.set(entry.id, {
        inventory: entry,
        stage,
        members,
        ...ownership,
        ...(run ? { run: run.state } : {}),
      });
    }),
  );
  return {
    context,
    facts,
    entries: new Map(entries.map((entry) => [entry.id, entry])),
    status: backlog.status,
    diagnostics: inventory.diagnostics,
  };
}

/** The Work payload for one companion. */
async function assembleWork(
  companionPath: string,
  input: WorkInput,
  lastFailure?: GitFailure,
): Promise<StudioWorkPayload> {
  const model = await readWorkModel(companionPath, input, lastFailure);
  const cards = [...model.facts.values()]
    .map((facts): StudioWorkCard => {
      const card = projectWorkCard(facts, model.context);
      const entry = facts.inventory;
      const run = input.factory.mode ? input.runs?.[entry.id] : undefined;
      const active = activeMembers(entry);
      return {
        ...card,
        title: entry.record.title,
        intent: entry.record.intent,
        repositories: entry.record.repositories,
        implicit: entry.implicit,
        memberNames: active,
        artifacts: Object.fromEntries(
          active.map((change) => [change, [`openspec/changes/${change}/proposal.md`]]),
        ),
        offers: card.bucket === "remote" ? [] : offersFor(entry, facts.stage.stage, input),
        ...(run ? { run: run.state } : {}),
        needsYou: needsPerson(card, run),
      };
    })
    .toSorted((a, b) => a.id.localeCompare(b.id));
  return {
    writable: input.writable,
    factory: input.factory,
    operator: model.context.operator ?? null,
    gitBacked: model.context.gitBacked,
    team: teamOf(model.status),
    cards,
    needsYou: cards.filter((card) => card.needsYou).length,
    linkedRepositories: input.linkedRepositories ?? [],
    ticketFormat: input.ticketFormat ?? "none",
    diagnostics: model.diagnostics,
  };
}

// Actions -----------------------------------------------------------------------------

export type WorkRequest =
  | {
      action: "capture";
      text: string;
      repository?: string;
      ticket?: string;
      /** Start in local factory with this mode; absent saves to Scratchpad. */
      start?: "propose-only" | "delivery";
    }
  | { action: "refresh" }
  | { action: "share-preview"; workset: string; include?: string[] }
  | { action: "share"; workset: string; hash: string; include?: string[]; key: string }
  | { action: "claim" | "release"; workset: string; members: string[]; key: string }
  | { action: "start-manual"; workset: string; members: string[] }
  | { action: "dispatch"; workset: string; mode: "propose-only" | "delivery"; members: string[] }
  | { action: "park" | "move-to-later"; workset: string };

export { WORK_REQUEST_ACTIONS } from "./work-requests";

export type WorkRefusalKind =
  | "prerequisite"
  | "access"
  | "conflict"
  | "stale"
  | "factory-unavailable"
  | "failed";

export type WorkResult =
  | {
      ok: true;
      preview?: SharePreview;
      prompts?: Partial<Record<TerminalAgent, string>>[];
      /** Claimed changes this checkout does not have yet; `mate artifact take` brings each in. */
      needsTake?: string[];
    }
  | { ok: false; kind: WorkRefusalKind; reason: string };

export interface WorkServiceDeps {
  writable: boolean;
  factoryMode: boolean;
  outcomesFor: (companionPath: string) => Outcomes;
  broker: Pick<FactoryClient, "info"> | null;
  /**
   * The changes, shipped archives and runs the payload already collected for the companion;
   * `refresh` collects them again, as Work's Refresh does.
   */
  inputFor: (
    companionPath: string,
    refresh?: boolean,
  ) => Promise<Omit<WorkInput, "writable" | "factory">>;
}

const BROKER_TIMEOUT_MS = 3_000;

/** Factory mode, then whether this companion's local factory can take dispatches now. */
export async function factoryAvailability(
  companionPath: string,
  deps: Pick<WorkServiceDeps, "factoryMode" | "outcomesFor" | "broker">,
): Promise<FactoryAvailability> {
  if (!deps.factoryMode || !deps.broker) return { mode: false, usable: false };
  if (!deps.outcomesFor(companionPath).automated) {
    return {
      mode: true,
      usable: false,
      reason: "the factory runner does not serve this companion",
    };
  }
  try {
    const info = await Promise.race([
      deps.broker.info(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), BROKER_TIMEOUT_MS).unref?.(),
      ),
    ]);
    if (info.credential === null) return { mode: true, usable: false, reason: NO_CREDENTIAL };
    return { mode: true, usable: true };
  } catch {
    return { mode: true, usable: false, reason: "the factory broker is not reachable" };
  }
}

const NOT_WRITABLE = "start Studio with --writable to change Work";
const NO_OPERATOR = "configure Git user.name and user.email in the companion first";
const FACTORY_NOT_USABLE = "the local factory is not usable";

function refusal(kind: WorkRefusalKind, reason: string): WorkResult {
  return { ok: false, kind, reason };
}

function refusalKindOf(action: WorkActionId, reason: string): WorkRefusalKind {
  if (reason.includes("read-only") || reason.startsWith("claimed by")) return "access";
  if (FACTORY_WORK_ACTIONS.has(action) && /factory|runner|credential|broker/i.test(reason)) {
    return "factory-unavailable";
  }
  return "conflict";
}

/** The card action a request is checked against; previewing a share is checked as Share. */
function policyActionOf(
  action: Exclude<WorkRequest["action"], "refresh" | "capture">,
): WorkActionId {
  return action === "share-preview" ? "share" : action;
}

/** Saves to Scratchpad, or starts in the local factory when the request names a mode. */
async function capture(
  companionPath: string,
  request: Extract<WorkRequest, { action: "capture" }>,
  deps: WorkServiceDeps,
): Promise<WorkResult> {
  const outcomes = deps.outcomesFor(companionPath);
  if (request.start) {
    const factory = await factoryAvailability(companionPath, deps);
    if (!factory.mode) {
      return refusal("factory-unavailable", "the factory is not available on this installation");
    }
    if (!factory.usable) {
      return refusal("factory-unavailable", factory.reason ?? FACTORY_NOT_USABLE);
    }
  }
  const fields = (name: string): string =>
    ({
      text: request.text,
      repository: request.repository ?? "",
      ticket: request.ticket ?? "",
      start: request.start ? "start" : "later",
      mode: request.start ?? "",
    })[name] ?? "";
  if (request.start) await outcomes.create(fields);
  else await createOutcomeFrom(companionPath, fields);
  return { ok: true };
}

/** Work's server-side services for one Studio process. */
export function createWorkServices(deps: WorkServiceDeps) {
  // The last failed refresh per companion, until one succeeds; Git keeps everything else.
  const failures = new Map<string, GitFailure>();

  const inputOf = async (companionPath: string): Promise<WorkInput> => ({
    ...(await deps.inputFor(companionPath)),
    writable: deps.writable,
    factory: await factoryAvailability(companionPath, deps),
  });

  async function act(companionPath: string, request: WorkRequest): Promise<WorkResult> {
    if (request.action === "refresh") {
      const [refreshed] = await Promise.all([
        refreshTeam(companionPath),
        // A failed collection keeps the last snapshot; the next load collects again.
        deps.inputFor(companionPath, true).catch(() => undefined),
      ]);
      if ("failure" in refreshed) {
        failures.set(companionPath, refreshed.failure);
        return refusal("failed", refreshed.failure.message);
      }
      failures.delete(companionPath);
      return { ok: true };
    }
    if (!deps.writable) return refusal("access", NOT_WRITABLE);
    if (request.action === "capture") return capture(companionPath, request, deps);

    const input = await inputOf(companionPath);
    const model = await readWorkModel(companionPath, input, failures.get(companionPath));
    const facts = model.facts.get(request.workset);
    const entry = model.entries.get(request.workset);
    if (!facts || !entry) return refusal("prerequisite", `no Workset ${request.workset}`);
    const action = policyActionOf(request.action);
    const reason = workActionRefusal(action, facts, model.context);
    if (reason) return refusal(refusalKindOf(action, reason), reason);
    const operator = model.context.operator;
    const members = activeMembers(facts.inventory);
    if ("members" in request && !sameMembers(members, request.members)) {
      return refusal("stale", `its changes are now ${members.join(", ")}; review it again`);
    }

    switch (request.action) {
      case "share-preview": {
        const backlog = await readTeamBacklog(companionPath, failures.get(companionPath));
        const preview = await previewShare(companionPath, entry, backlog, {
          include: request.include,
        });
        return "refusal" in preview
          ? refusal("prerequisite", preview.refusal)
          : { ok: true, preview: preview.preview };
      }
      case "share": {
        const outcome = await confirmShare(
          companionPath,
          { hash: request.hash, include: request.include, transactionId: `tx-${request.key}` },
          {
            inventoryEntry: async () => {
              const [inventory, backlog] = await Promise.all([
                readWorkInventory(companionPath),
                readTeamBacklog(companionPath),
              ]);
              return findEntry(inventory, backlog, request.workset);
            },
          },
        );
        if (outcome.status === "shared") return { ok: true };
        if (outcome.status === "failed") return refusal("failed", outcome.failure.message);
        return refusal(outcome.status === "stale" ? "stale" : "conflict", outcome.reason);
      }
      case "claim":
      case "release": {
        if (!operator) return refusal("prerequisite", NO_OPERATOR);
        const outcome = await updateClaim(companionPath, {
          action: request.action,
          members: request.members,
          operator,
          transactionId: `tx-${request.key}`,
          workset: entry.id,
          runningHere: isActiveRun(facts.run),
        });
        if (outcome.status === "accepted") {
          return {
            ok: true,
            ...(outcome.needsTake.length > 0 ? { needsTake: outcome.needsTake } : {}),
          };
        }
        if (outcome.status === "failed") return refusal("failed", outcome.failure.message);
        if (outcome.status === "stale") return refusal("stale", outcome.reason);
        return refusal(outcome.kind, outcome.reason);
      }
      case "start-manual": {
        const refused = await startRefusal(companionPath, entry.id, { needsPlan: true });
        if (refused) return refusal("conflict", refused);
        const offers = offersFor(entry, facts.stage.stage, input);
        return { ok: true, prompts: offers.map((offer) => offer.prompts) };
      }
      case "dispatch": {
        const outcomes = deps.outcomesFor(companionPath);
        if (!outcomes.dispatch) {
          return refusal("factory-unavailable", FACTORY_NOT_USABLE);
        }
        await outcomes.dispatch(request.workset, request.mode, { members: request.members });
        return { ok: true };
      }
      case "park": {
        const outcomes = deps.outcomesFor(companionPath);
        if (!outcomes.park) return refusal("factory-unavailable", FACTORY_NOT_USABLE);
        await outcomes.park(request.workset);
        return { ok: true };
      }
      case "move-to-later":
        await deps.outcomesFor(companionPath).act(request.workset, "later", () => "");
        return { ok: true };
    }
  }

  return {
    async work(companionPath: string): Promise<StudioWorkPayload> {
      return assembleWork(companionPath, await inputOf(companionPath), failures.get(companionPath));
    },
    act,
  };
}
