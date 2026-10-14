import fs from "node:fs/promises";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { writeAtomic } from "../../runtime/write-atomic";
import { instructionBlockKey } from "./context-services";
import type { CapabilityContributionInput, RuntimeContributions } from "./plugin";

/**
 * Contribution Ledger: which plugin owns each contribution a persisted pass
 * applied to the companion, per Agent Runtime. Committed with the companion,
 * because it describes committed files: a clone that never loaded a plugin
 * must still be able to remove what another clone committed. It records
 * identities only (names, block keys, markers, entries), never a value, so it
 * carries no secret.
 */

export const CONTRIBUTION_LEDGER_VERSION = 1;

/** The identities one owner applied on one runtime. Absent kinds are none. */
export interface LedgerIdentities {
  mcpServers?: string[];
  guidanceKeys?: string[];
  skillTrees?: string[];
  agentDefinitions?: string[];
  hookMarkers?: string[];
  permissionEntries?: string[];
  pluginReferences?: string[];
}

export interface ContributionLedger {
  version: number;
  /** Runtime id → owning plugin id → identities. */
  runtimes: Record<string, Record<string, LedgerIdentities>>;
  /** Audience plugin packages the upgrade sweep could not load; retried by every pass. */
  unswept?: string[];
}

export function contributionLedgerPath(companionPath: string): string {
  return path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "contribution-ledger.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

const IDENTITY_KINDS = [
  "agentDefinitions",
  "guidanceKeys",
  "hookMarkers",
  "mcpServers",
  "permissionEntries",
  "pluginReferences",
  "skillTrees",
] as const satisfies readonly (keyof LedgerIdentities)[];

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted();
}

/** Sorted kinds and values, empty kinds dropped; `null` when nothing is left. */
function normalizeIdentities(identities: LedgerIdentities): LedgerIdentities | null {
  const normalized: LedgerIdentities = {};
  for (const kind of IDENTITY_KINDS) {
    const values = sortedUnique(identities[kind] ?? []);
    if (values.length > 0) normalized[kind] = values;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

/** Sorted runtimes and owners; empty owners and runtimes dropped. */
function normalizeLedger(ledger: ContributionLedger): ContributionLedger {
  const runtimes: ContributionLedger["runtimes"] = {};
  for (const runtimeId of Object.keys(ledger.runtimes).toSorted()) {
    const owners: Record<string, LedgerIdentities> = {};
    for (const owner of Object.keys(ledger.runtimes[runtimeId] ?? {}).toSorted()) {
      const identities = normalizeIdentities(ledger.runtimes[runtimeId]![owner]!);
      if (identities) owners[owner] = identities;
    }
    if (Object.keys(owners).length > 0) runtimes[runtimeId] = owners;
  }
  const unswept = sortedUnique(ledger.unswept ?? []);
  return {
    version: CONTRIBUTION_LEDGER_VERSION,
    runtimes,
    ...(unswept.length > 0 ? { unswept } : {}),
  };
}

/** The companion's ledger; `null` when absent or unreadable, which a pass treats as never recorded. */
export async function readContributionLedger(
  companionPath: string,
): Promise<ContributionLedger | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(contributionLedgerPath(companionPath), "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.runtimes)) return null;
  const runtimes: ContributionLedger["runtimes"] = {};
  for (const [runtimeId, owners] of Object.entries(parsed.runtimes)) {
    if (!isRecord(owners)) continue;
    runtimes[runtimeId] = {};
    for (const [owner, identities] of Object.entries(owners)) {
      if (!isRecord(identities)) continue;
      const read: LedgerIdentities = {};
      for (const kind of IDENTITY_KINDS) read[kind] = stringList(identities[kind]);
      runtimes[runtimeId][owner] = read;
    }
  }
  return normalizeLedger({
    version: CONTRIBUTION_LEDGER_VERSION,
    runtimes,
    unswept: stringList(parsed.unswept),
  });
}

/** Writes the ledger in its stable form; an unchanged ledger leaves the file untouched. */
export async function writeContributionLedger(
  companionPath: string,
  ledger: ContributionLedger,
): Promise<void> {
  const target = contributionLedgerPath(companionPath);
  const text = `${JSON.stringify(normalizeLedger(ledger), null, 2)}\n`;
  const existing = await fs.readFile(target, "utf8").catch(() => null);
  if (existing === text) return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await writeAtomic(target, text);
}

/** The identities a contribution set applies for `pluginId`. */
export function identitiesOf(
  pluginId: string,
  contributions: RuntimeContributions,
): LedgerIdentities {
  return {
    mcpServers: (contributions.mcpServers ?? []).map((server) => server.name),
    guidanceKeys: (contributions.guidanceSections ?? []).map((section) =>
      instructionBlockKey(pluginId, section.content),
    ),
    skillTrees: (contributions.skillTrees ?? []).map((tree) => tree.name),
    agentDefinitions: (contributions.agentDefinitions ?? []).map((agent) => agent.name),
    hookMarkers: (contributions.hookGroups ?? []).map((hook) => hook.marker),
    permissionEntries: [...(contributions.permissionEntries ?? [])],
    pluginReferences: (contributions.pluginReferences ?? []).map((entry) => entry.reference),
  };
}

/** The ledger a pass leaves: what its enabled inputs applied, per runtime and owner. */
export function ledgerFromInputs(
  inputsByRuntime: ReadonlyMap<string, readonly CapabilityContributionInput[]>,
  unswept: readonly string[] = [],
): ContributionLedger {
  const runtimes: ContributionLedger["runtimes"] = {};
  for (const [runtimeId, inputs] of inputsByRuntime) {
    const owners: Record<string, LedgerIdentities> = {};
    for (const input of inputs) {
      if (!input.enabled) continue;
      const identities = identitiesOf(input.pluginId, input.contributions);
      const merged = owners[input.pluginId] ?? {};
      for (const kind of IDENTITY_KINDS) {
        merged[kind] = [...(merged[kind] ?? []), ...(identities[kind] ?? [])];
      }
      owners[input.pluginId] = merged;
    }
    runtimes[runtimeId] = owners;
  }
  return normalizeLedger({ version: CONTRIBUTION_LEDGER_VERSION, runtimes, unswept: [...unswept] });
}

/**
 * A disabled input naming every recorded identity of `owner`, so each Runtime
 * Surface removes them through its existing disabled-input path. Removal keys
 * on identity only, so no value is needed: guidance is stripped by owner, a
 * hook group by its marker, a plugin reference by its exact entry.
 */
export function ledgerTeardownInput(
  owner: string,
  identities: LedgerIdentities,
): CapabilityContributionInput {
  return {
    pluginId: owner,
    enabled: false,
    capabilityEnabled: false,
    contributions: {
      mcpServers: (identities.mcpServers ?? []).map((name) => ({ name })),
      guidanceSections: (identities.guidanceKeys ?? []).length > 0 ? [{ content: "" }] : [],
      skillTrees: (identities.skillTrees ?? []).map((name) => ({ name, sourceDir: "" })),
      agentDefinitions: (identities.agentDefinitions ?? []).map((name) => ({ name, content: "" })),
      hookGroups: (identities.hookMarkers ?? []).map((marker) => ({
        event: "",
        marker,
        group: {},
      })),
      permissionEntries: [...(identities.permissionEntries ?? [])],
      pluginReferences: (identities.pluginReferences ?? []).map((reference) => ({
        reference,
        isManagedReference: (entry: unknown) => entry === reference,
      })),
    },
  };
}
