import type { DeliveryEnvironment } from "../../../../lib/delivery/environment";
import { sameRepository } from "../../../../lib/delivery/record";
import type { DeliveryEdit } from "../../../../lib/delivery/record-delivery";
import { type CliFlags, malformedValueFlag, stringFlag } from "../../../parse-flags";

/** `--branch` with `--direct`, or `--not-applicable`, as `artifact link` and `archive` take them. */
export interface BranchFlags {
  branch?: string;
  direct: boolean;
  notApplicable?: string;
}

export function branchFlagsFrom(flags: CliFlags): BranchFlags {
  return {
    branch: stringFlag(flags.branch),
    direct: flags.direct === true,
    notApplicable: stringFlag(flags["not-applicable"]),
  };
}

export const DIRECT_NEEDS_BRANCH = "mate: --direct records a direct delivery and needs --branch.";

/** The delivery edit the branch flags ask for; `--branch` wins over `--not-applicable`. */
export function deliveryEditFrom(flags: BranchFlags): DeliveryEdit["delivery"] {
  if (flags.branch !== undefined) return { branch: flags.branch, direct: flags.direct };
  if (flags.notApplicable !== undefined) return { notApplicable: flags.notApplicable };
  return undefined;
}

/** Refuses a value flag given bare or repeated, which would otherwise read as absent. */
export function valueFlagError(flags: CliFlags, names: readonly string[]): string | undefined {
  const name = malformedValueFlag(flags, names);
  return name === undefined ? undefined : `mate: --${name} takes exactly one value.`;
}

/** `--repository <org/repo>`, or the refusal for a malformed one. */
export function repositoryFlag(flags: CliFlags): { repository?: string } | { error: string } {
  const repository = stringFlag(flags.repository);
  if (repository !== undefined && !/^[\w.-]+(?:\/[\w.-]+)+$/.test(repository)) {
    return {
      error:
        "mate: --repository expects a repository path such as <org/repo> or <group/subgroup/repo>.",
    };
  }
  return repository === undefined ? {} : { repository };
}

/** GitHub slugs are case-insensitive; the Working Repository's own spelling keeps one delivery. */
export function canonicalRepository(
  environment: DeliveryEnvironment,
  requested: string | undefined,
): string | undefined {
  const own = environment.workingRepo?.slug;
  return own && requested !== undefined && sameRepository(requested, own) ? own : requested;
}
