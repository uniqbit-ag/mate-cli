import {
  GROUP_CHARACTERS,
  groupOf,
  namesGroup,
  repositorySegment,
} from "../../../runtime/pending-records";
import { sameRepository, type DeliveryRecord } from "../record";

export { repositorySegment };

export interface DeliveryGroupName {
  /** Delivery Group, e.g. `acme_widgets/workset/acme-login`. */
  group: string;
  /** The repository the group is named after; absent for `change/<change>`. */
  repository?: string;
  /** Set when the record names different branches for different repositories. */
  warning?: string;
}

/**
 * The Delivery Group of a change: `<repository>/<branch>` after the recorded
 * Delivery Branch, preferring the first scoped repository's, else `change/<change>` when no
 * valid branch is recorded. A recorded value that is no Git branch name (`..`, a leading `/`),
 * or whose branch or repository holds other characters than letters, digits, `_`, `.`, `/` and
 * `-` or starts with `.`, `/` or `-`, is ignored with a warning.
 */
export function deliveryGroupFor(
  change: string,
  record: DeliveryRecord | null,
  scopedRepositories: readonly string[] = [],
): DeliveryGroupName {
  const recorded = (record?.deliveries ?? []).filter(
    (entry): entry is typeof entry & { branch: string } =>
      typeof entry.branch === "string" && entry.branch.length > 0,
  );
  const branches = recorded.filter(namesGroup);
  const invalid = recorded.length - branches.length;
  if (branches.length === 0) {
    return {
      group: `change/${change}`,
      ...(invalid > 0
        ? { warning: `${change} records no valid branch name; submitting it in change/${change}.` }
        : {}),
    };
  }

  const preferred =
    scopedRepositories
      .map((repository) => branches.find((entry) => sameRepository(entry.repository, repository)))
      .find((entry) => entry !== undefined) ?? branches[0];
  const distinct = [...new Set(branches.map((entry) => entry.branch))];
  const group = groupOf(preferred);
  return {
    group,
    repository: preferred.repository,
    ...(distinct.length > 1
      ? {
          warning: `${change} records different branches (${distinct.join(", ")}); submitting it in ${group}.`,
        }
      : {}),
  };
}

/** True for a Delivery Group as a publish target; change names and anchors hold no `/`. */
export function isDeliveryGroup(target: string): boolean {
  return /^[^/]+\/.*[^/]$/.test(target) && GROUP_CHARACTERS.test(target) && !target.includes("..");
}
