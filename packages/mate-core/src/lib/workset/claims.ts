import { parse, stringify } from "yaml";

/**
 * A claim: `openspec/changes/<change>/owner.yaml` in every active member of a Workset,
 * written only by Claim and removed by Release. A change without the file is unclaimed.
 */

export const OWNER_FILE = "owner.yaml";

/** A trusted-writer identity: Git email as the stable id, Git name as the label. */
export interface Operator {
  id: string;
  label: string;
}

/** What one change's owner file says: nobody, an owner, or something unreadable. */
export type OwnerRead =
  | { status: "absent" }
  | { status: "owned"; owner: Operator }
  | { status: "invalid"; diagnostic: string };

const OPERATOR_ID = /^[^\s@]+@[^\s@]+$/;

function isOperatorId(id: string): boolean {
  return id.length <= 254 && OPERATOR_ID.test(id);
}

export function parseOwner(source: string | null): OwnerRead {
  if (source === null) return { status: "absent" };
  let document: unknown;
  try {
    document = parse(source);
  } catch {
    return { status: "invalid", diagnostic: `${OWNER_FILE} is not YAML` };
  }
  const owner = (document as { owner?: unknown } | null)?.owner as
    | { id?: unknown; label?: unknown }
    | undefined;
  if (
    !owner ||
    typeof owner.id !== "string" ||
    !isOperatorId(owner.id) ||
    typeof owner.label !== "string" ||
    !owner.label.trim() ||
    owner.label.length > 128
  ) {
    return {
      status: "invalid",
      diagnostic: `${OWNER_FILE} names no owner with an email and a name`,
    };
  }
  return { status: "owned", owner: { id: owner.id.toLowerCase(), label: owner.label.trim() } };
}

export function serializeOwner(owner: Operator): string {
  return stringify({ owner: { id: owner.id, label: owner.label } });
}

/** The group's claim from its members' files: one owner, none, or a conflict. */
export type GroupClaim =
  | { kind: "none" }
  | { kind: "owned"; owner: Operator }
  | { kind: "conflict"; diagnostic: string };

export function groupClaim(reads: readonly OwnerRead[]): GroupClaim {
  const invalid = reads.find((read) => read.status === "invalid");
  if (invalid?.status === "invalid") return { kind: "conflict", diagnostic: invalid.diagnostic };
  const owners = reads.flatMap((read) => (read.status === "owned" ? [read.owner] : []));
  if (owners.length === 0) return { kind: "none" };
  const ids = new Set(owners.map((owner) => owner.id));
  if (ids.size > 1) {
    return {
      kind: "conflict",
      diagnostic: `its changes name different owners (${[...new Set(owners.map((o) => o.label))].join(", ")})`,
    };
  }
  if (owners.length < reads.length) {
    return { kind: "conflict", diagnostic: "only some of its changes are claimed" };
  }
  return { kind: "owned", owner: owners[0]! };
}
