import { createHash } from "node:crypto";
import path from "node:path";

import { cloneOf, realPath } from "../../runtime/git-layout";
import { readFrameworkRaw } from "../../tools/setup/dynamic-plugins/audiences";
import {
  collectWorkspaceInventory,
  type WorkspaceInventoryV1,
} from "../orchestrator/workspace-inventory";
import { linkedCheckoutsOf, type EntryCheckout } from "../orchestrator/umbrella-checkouts";
import { registeredCheckoutOf } from "../orchestrator/registry-checkouts";
import { UsageError } from "./types";

export interface UsageScopeRepository {
  id: string;
  kind: "companion" | "working";
  label: string;
  path: string;
  aliases: string[];
  available: boolean;
}

export interface UsageScope {
  companionPath: string;
  companionId: string;
  repositories: UsageScopeRepository[];
  capabilities: string[];
  fingerprint: string;
}

interface CheckoutIdentity {
  key: string;
  aliases: string[];
}

export interface UsageScopeDeps {
  inventory?: () => Promise<WorkspaceInventoryV1>;
  checkouts?: (entry: { path: string }) => Promise<EntryCheckout[]>;
  identity?: (folder: string) => CheckoutIdentity;
  /** Current checkout of a registry entry, following a moved clone; null when none exists. */
  registered?: typeof registeredCheckoutOf;
  capabilities?: (companionPath: string) => Promise<string[]>;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function checkoutIdentity(folder: string): CheckoutIdentity {
  const clone = cloneOf(folder);
  return {
    key: clone?.commonDir ?? realPath(folder),
    aliases: [
      realPath(folder),
      ...(clone?.mainWorktree ? [clone.mainWorktree] : []),
      ...(clone?.linkedWorktrees.map((checkout) => checkout.path) ?? []),
    ],
  };
}

async function enabledCapabilities(companionPath: string): Promise<string[]> {
  const raw = await readFrameworkRaw(companionPath);
  if (!raw || typeof raw !== "object") return [];
  const entries = (raw as { capabilities?: unknown }).capabilities;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const name = (entry as { name?: unknown }).name;
    return typeof name === "string" ? [name] : [];
  });
}

/** Read-only scope; never repairs registry entries or selects a Working Repository. */
export async function resolveUsageScope(
  companionPath: string,
  deps: UsageScopeDeps = {},
): Promise<UsageScope> {
  const inventory = await (deps.inventory ?? collectWorkspaceInventory)();
  const root = path.resolve(companionPath);
  const companion = inventory.companions.find((entry) => path.resolve(entry.path) === root);
  if (!companion || companion.health !== "ready") {
    throw new UsageError(
      "COMPANION_UNRESOLVED",
      "The selected companion is not readable or registered",
    );
  }
  const identity = deps.identity ?? checkoutIdentity;
  const companionIdentity = identity(root);
  const companionId = digest(root);
  const repositories = new Map<string, UsageScopeRepository>([
    [
      companionIdentity.key,
      {
        id: companionId,
        kind: "companion",
        label: "Companion Repository",
        path: root,
        aliases: [...new Set(companionIdentity.aliases)],
        available: true,
      },
    ],
  ]);
  for (const pairing of inventory.pairings.filter(
    (entry) => path.resolve(entry.companionPath) === root,
  )) {
    const registered =
      (deps.registered ?? registeredCheckoutOf)(pairing.repository) ?? pairing.repository.path;
    const available = pairing.health === "ready" || registered !== pairing.repository.path;
    const children = available
      ? // oxlint-disable-next-line no-await-in-loop -- bound discovery to one registry entry at a time
        await (deps.checkouts ?? linkedCheckoutsOf)({ ...pairing.repository, path: registered })
      : [{ path: pairing.repository.path, remote: null, origin: null }];
    for (const child of children) {
      const checkout = identity(child.path);
      const existing = repositories.get(checkout.key);
      if (existing) {
        existing.aliases = [...new Set([...existing.aliases, ...checkout.aliases])];
        existing.available ||= available;
        continue;
      }
      const label = child.remote
        ? `${child.remote.owner}/${child.remote.repo}`
        : pairing.repository.id;
      repositories.set(checkout.key, {
        id: digest(checkout.key),
        kind: "working",
        label,
        path: child.path,
        aliases: [...new Set(checkout.aliases)],
        available,
      });
    }
  }
  const capabilities = [
    ...new Set(await (deps.capabilities ?? enabledCapabilities)(root)),
  ].toSorted();
  const rows = [...repositories.values()].toSorted(
    (a, b) =>
      Number(b.kind === "companion") - Number(a.kind === "companion") ||
      a.label.localeCompare(b.label) ||
      a.id.localeCompare(b.id),
  );
  return {
    companionPath: root,
    companionId,
    repositories: rows,
    capabilities,
    fingerprint: digest(JSON.stringify({ rows, capabilities })),
  };
}

/** Per-scope memo: one realpath per distinct directory, not per usage record. */
const attributions = new WeakMap<UsageScope, Map<string, UsageScopeRepository | null>>();

/** Exact roots/descendants only; the longest matching checkout owns nested activity. */
export function repositoryForPath(
  scope: UsageScope,
  directory: string,
): UsageScopeRepository | null {
  if (!path.isAbsolute(directory)) return null;
  let memo = attributions.get(scope);
  if (!memo) attributions.set(scope, (memo = new Map()));
  if (memo.has(directory)) return memo.get(directory)!;
  const repository = attributedRepository(scope, realPath(directory));
  memo.set(directory, repository);
  return repository;
}

function attributedRepository(scope: UsageScope, candidate: string): UsageScopeRepository | null {
  const matches = scope.repositories.flatMap((repository) =>
    repository.aliases
      .filter((alias) => candidate === alias || candidate.startsWith(`${alias}${path.sep}`))
      .map((alias) => ({ repository, length: alias.length })),
  );
  const ordered = matches.toSorted((a, b) => b.length - a.length);
  if (
    ordered[1]?.length === ordered[0]?.length &&
    ordered[1]?.repository.id !== ordered[0]?.repository.id
  )
    return null;
  return ordered[0]?.repository ?? null;
}
