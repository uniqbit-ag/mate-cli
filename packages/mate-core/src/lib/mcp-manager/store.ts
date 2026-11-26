import crypto from "node:crypto";
import fs from "node:fs/promises";

import { parseDocument } from "yaml";

import { FRAMEWORK_NAME } from "../../framework";
import { companionFrameworkConfigPath } from "../../runtime/policy";
import { writeAtomic } from "../../runtime/write-atomic";
import { BASE_AUDIENCE, declaredAudiences } from "../../tools/setup/dynamic-plugins/audiences";
import { parseFrameworkConfig } from "../orchestrator/config-store";
import { ConfigError, type FrameworkConfig } from "../orchestrator/types";
import { resolveMcpServers } from "./resolve";
import type { McpManagerAudienceSelection, McpManagerConfig } from "./types";
import { mcpManagerEngineRange } from "./validate";

/** `framework.yaml` changed after the read whose token a write carries. */
export class McpManagerConflictError extends Error {
  constructor() {
    super("framework.yaml changed since it was read; read it again and reapply the change.");
  }
}

export interface McpManagerSnapshot {
  /** The root section; null when the companion declares none. */
  catalog: McpManagerConfig | null;
  /** Each declared audience's selection; `{}` when it selects nothing. */
  audiences: Record<string, McpManagerAudienceSelection>;
  /** Effective server names for the base set and per declared audience. */
  effective: { base: string[]; audiences: Record<string, string[]> };
  /** Content hash of `framework.yaml`, the concurrency token a write carries. */
  token: string;
}

/**
 * A change to the section. `catalog: null` removes the root section; an
 * audience mapped to null loses its selection. Absent keys stay unchanged.
 */
export interface McpManagerPatch {
  catalog?: McpManagerConfig | null;
  audiences?: Record<string, McpManagerAudienceSelection | null>;
}

function tokenOf(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function snapshotOf(config: FrameworkConfig, token: string): McpManagerSnapshot {
  const names = declaredAudiences(config);
  const effective = (audience: string | null) =>
    resolveMcpServers(config, audience).map((server) => server.name);
  return {
    catalog: config.mcpManager ?? null,
    audiences: Object.fromEntries(
      names.map((name) => [name, config.audiences?.[name]?.mcpManager ?? {}]),
    ),
    effective: {
      base: effective(null),
      audiences: Object.fromEntries(names.map((name) => [name, effective(name)])),
    },
    token,
  };
}

async function readText(companionPath: string): Promise<string> {
  return fs.readFile(companionFrameworkConfigPath(companionPath), "utf8");
}

/** The catalog, audience selections and effective sets, validated as loading validates them. */
export async function readMcpManager(companionPath: string): Promise<McpManagerSnapshot> {
  const text = await readText(companionPath);
  return snapshotOf(parseFrameworkConfig(parseDocument(text).toJS()), tokenOf(text));
}

/**
 * Applies `patch` to `framework.yaml`, keeping comments, key order and every
 * other key. Fails with {@link McpManagerConflictError} when the file changed
 * since `token`'s read, and with the loader's error when the result is
 * invalid; either way the file is left unchanged.
 */
export async function writeMcpManager(
  companionPath: string,
  patch: McpManagerPatch,
  token: string,
): Promise<McpManagerSnapshot> {
  const text = await readText(companionPath);
  if (tokenOf(text) !== token) throw new McpManagerConflictError();

  const document = parseDocument(text);
  if (patch.catalog === null) document.delete("mcpManager");
  else if (patch.catalog !== undefined) document.set("mcpManager", patch.catalog);
  for (const [audience, selection] of Object.entries(patch.audiences ?? {})) {
    if (audience === BASE_AUDIENCE) {
      throw new ConfigError(
        `"${BASE_AUDIENCE}" is the base set; write its servers to the catalog.`,
      );
    }
    if (selection === null) document.deleteIn(["audiences", audience, "mcpManager"]);
    else document.setIn(["audiences", audience, "mcpManager"], selection);
  }

  const raw = document.toJS() as Record<string, unknown>;
  const config = parseFrameworkConfig(raw);
  const raised = mcpManagerEngineRange(raw);
  if (raised !== null) document.setIn(["engines", FRAMEWORK_NAME], raised);

  const next = document.toString();
  await writeAtomic(companionFrameworkConfigPath(companionPath), next);
  return snapshotOf(config, tokenOf(next));
}
