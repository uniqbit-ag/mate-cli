import { locateChange } from "../change-layout";
import { runOpenSpec, type RunOpenSpec } from "../openspec-cli";
import { companionRelative, type DeliveryEnvironment } from "./environment";
import { archiveWarnings, planningWarning, type ArchiveWarning } from "./overlap";
import {
  isPublishable,
  settleDelivery,
  type DeliveryRecord,
  type DeliverySettlement,
  type UnscopedDelivery,
} from "./record";
import {
  recordDelivery,
  type DeliveryEdit,
  type DeliveryRefusal,
  type RecordDeliveryDeps,
} from "./record-delivery";
import type { BranchOutcome } from "./refresh";

export type ArchiveStatus = "archived" | "needs-branch" | "failed";

export interface ArchiveResult {
  status: ArchiveStatus;
  change: string;
  /** Companion-relative archive directory, once archived. */
  path: string | null;
  record: DeliveryRecord;
  settlement: DeliverySettlement;
  outcomes: BranchOutcome[];
  warnings: ArchiveWarning[];
  /** `needs-branch` only: the branch to suggest, when it exists. */
  suggestedBranch?: string | null;
  message: string;
}

export interface ArchiveRequest {
  change: string;
  /** The repository `delivery` is recorded for; defaults to the Working Repository. */
  repository?: string;
  /** Recorded before the refresh, as `artifact link` would. */
  delivery?: DeliveryEdit["delivery"];
  /** Archive with an unlinked record instead of answering `needs-branch`. */
  skipBranch?: boolean;
}

export type ArchiveOutcome = { refusal: DeliveryRefusal } | { result: ArchiveResult };

export interface ArchiveChangeDeps extends RecordDeliveryDeps {
  runOpenSpec?: RunOpenSpec;
  /**
   * Called once before `openspec archive` starts, so warnings are visible even when the
   * archive fails or hangs. Never called for `needs-branch` or a refusal.
   */
  onWarnings?: (warnings: ArchiveWarning[], unscoped: UnscopedDelivery[]) => void;
}

/**
 * The Archive change stage: records and refreshes the delivery, collects overlap,
 * dependency, and incomplete-planning warnings, then runs `openspec archive`. Without a
 * recorded delivery and no `skipBranch`, nothing is archived and the result is
 * `needs-branch`. Merge state is reported, never a refusal.
 */
export async function archiveChange(
  environment: DeliveryEnvironment,
  request: ArchiveRequest,
  deps: ArchiveChangeDeps = {},
): Promise<ArchiveOutcome> {
  const { change } = request;
  const outcome = await recordDelivery(
    environment,
    {
      changes: [change],
      ...(request.repository ? { repository: request.repository } : {}),
      ...(request.delivery ? { edit: { delivery: request.delivery } } : {}),
      refresh: true,
      // The settlement covers every repository, so each delivery's merge state is refreshed.
      refreshAll: true,
      requireDelivery: !request.skipBranch,
    },
    deps,
  );
  if ("refusal" in outcome) return outcome;

  const runner = deps.runOpenSpec ?? runOpenSpec;
  const cwd = environment.companionPath;
  const [overlap, status] = await Promise.all([
    archiveWarnings(environment.companionPath, change),
    runner(["status", "--change", change, "--json"], { cwd }),
  ]);
  const planning = status.code === 0 ? planningWarning(change, status.stdout) : null;
  const warnings = [...overlap, ...(planning ? [planning] : [])];

  if ("needsBranch" in outcome) {
    const { record, suggestedBranch } = outcome.needsBranch;
    return {
      result: {
        status: "needs-branch",
        change,
        path: null,
        record,
        settlement: settleDelivery(record),
        outcomes: [],
        warnings,
        suggestedBranch,
        message: `No delivery branch is recorded for ${change}. Re-run with --branch <branch>, --not-applicable <reason>, or --skip-branch.`,
      },
    };
  }

  const [{ record, settlement, outcomes }] = outcome.results;
  deps.onWarnings?.(warnings, settlement.unscoped);

  const run = await runner(["archive", change, "--yes"], { cwd });
  if (run.code !== 0) {
    const detail = (run.stderr.trim() || run.stdout.trim()).split("\n").slice(-5).join("\n");
    return {
      result: {
        status: "failed",
        change,
        path: null,
        record,
        settlement,
        outcomes,
        warnings,
        message: `openspec archive ${change} failed (exit ${run.code ?? "unknown"}): ${detail}`,
      },
    };
  }

  const archived = await locateChange(environment.companionPath, change);
  return {
    result: {
      status: "archived",
      change,
      path: archived?.archived ? companionRelative(environment, archived.dir) : null,
      record,
      settlement,
      outcomes,
      warnings,
      message: archivedMessage(change, settlement),
    },
  };
}

function archivedMessage(change: string, settlement: DeliverySettlement): string {
  if (isPublishable(settlement.status)) {
    return `Archived ${change}; it can be published with mate-publish-artifact.`;
  }
  const missing =
    settlement.missing.length > 0
      ? ` No delivery is recorded for ${settlement.missing.join(", ")}, which its scopes name.`
      : "";
  return `Archived ${change}; publication waits until its delivery is merged (${settlement.status}).${missing}`;
}
