import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { readOpenSpecProjectSchema } from "../cap/openspec";
import {
  readAllChangeStatus,
  readOpenSpecJson,
  WORKFLOW_CAPABILITY_ID,
  type OpenSpecResult,
} from "./openspec-cli";

export interface WorkflowArtifact {
  id: string;
  description?: string;
  generates?: string;
  requires: string[];
}

export interface WorkflowEdge {
  from: string;
  to: string;
}

export interface WorkflowApplyStep {
  requires: string[];
  tracks?: string;
}

export interface WorkflowTopology {
  schemaName: string;
  /** Capability that owns this workflow, so a consumer can tell which skills drive it. */
  workflowCapabilityId: string;
  schemaVersion?: number;
  description?: string;
  source: "project" | "package";
  artifacts: WorkflowArtifact[];
  edges: WorkflowEdge[];
  apply: WorkflowApplyStep;
}

export interface SchemaLocation {
  path: string;
}

export interface WorkflowTopologyDeps {
  readProjectSchemaName?: (companionPath: string) => string | undefined;
  defaultSchemaName?: (companionPath: string) => Promise<string | undefined>;
  locateSchema?: (
    companionPath: string,
    schemaName: string,
  ) => Promise<OpenSpecResult<SchemaLocation>>;
  readFile?: (filePath: string) => Promise<string>;
}

const FALLBACK_SCHEMA_NAME = "spec-driven";

async function readDefaultSchemaName(companionPath: string): Promise<string | undefined> {
  const status = await readAllChangeStatus(companionPath);
  if (!status.ok) return undefined;
  return status.value.changes?.find((change) => change.planningHome?.defaultSchema)?.planningHome
    ?.defaultSchema;
}

function locateSchemaViaCli(
  companionPath: string,
  schemaName: string,
): Promise<OpenSpecResult<SchemaLocation>> {
  return readOpenSpecJson(companionPath, ["schema", "which", schemaName, "--json"]);
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function parseTopology(
  content: string,
  fallbackName: string,
  source: WorkflowTopology["source"],
): WorkflowTopology | { reason: string } {
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
  if (!parsed || typeof parsed !== "object") return { reason: "schema is not a mapping" };

  const document = parsed as Record<string, unknown>;
  if (!Array.isArray(document.artifacts)) {
    return { reason: "schema declares no artifacts list" };
  }

  const artifacts: WorkflowArtifact[] = [];
  for (const entry of document.artifacts) {
    if (!entry || typeof entry !== "object") continue;
    const artifact = entry as Record<string, unknown>;
    if (typeof artifact.id !== "string") continue;
    artifacts.push({
      id: artifact.id,
      ...(typeof artifact.description === "string" ? { description: artifact.description } : {}),
      ...(typeof artifact.generates === "string" ? { generates: artifact.generates } : {}),
      requires: toStringArray(artifact.requires),
    });
  }

  const declared = new Set(artifacts.map((artifact) => artifact.id));
  const edges: WorkflowEdge[] = [];
  for (const artifact of artifacts) {
    for (const requirement of artifact.requires) {
      if (declared.has(requirement)) edges.push({ from: requirement, to: artifact.id });
    }
  }

  const applyBlock =
    document.apply && typeof document.apply === "object"
      ? (document.apply as Record<string, unknown>)
      : {};

  return {
    schemaName: typeof document.name === "string" ? document.name : fallbackName,
    workflowCapabilityId: WORKFLOW_CAPABILITY_ID,
    ...(typeof document.version === "number" ? { schemaVersion: document.version } : {}),
    ...(typeof document.description === "string" ? { description: document.description } : {}),
    source,
    artifacts,
    edges,
    apply: {
      requires: toStringArray(applyBlock.requires),
      ...(typeof applyBlock.tracks === "string" ? { tracks: applyBlock.tracks } : {}),
    },
  };
}

/**
 * Reads the workflow graph of whichever schema a Companion Repository
 * resolves. Nothing about a particular schema is assumed: artifacts, their
 * dependency edges, and the apply step all come from the schema document, so a
 * schema that gains an artifact renders without a code change.
 */
export async function readWorkflowTopology(
  companionPath: string,
  deps: WorkflowTopologyDeps = {},
): Promise<OpenSpecResult<WorkflowTopology>> {
  const readSchemaName = deps.readProjectSchemaName ?? readOpenSpecProjectSchema;
  const readDefaultName = deps.defaultSchemaName ?? readDefaultSchemaName;
  const locate = deps.locateSchema ?? locateSchemaViaCli;
  const readFile = deps.readFile ?? ((filePath: string) => fs.readFile(filePath, "utf8"));

  const schemaName =
    readSchemaName(companionPath) ?? (await readDefaultName(companionPath)) ?? FALLBACK_SCHEMA_NAME;
  const command = `workflow topology for ${schemaName}`;

  let content: string | undefined;
  let source: WorkflowTopology["source"] = "project";
  try {
    content = await readFile(
      path.join(companionPath, "openspec", "schemas", schemaName, "schema.yaml"),
    );
  } catch {
    /** No project-local schema: fall through to the CLI-resolved location. */
  }

  if (content === undefined) {
    const located = await locate(companionPath, schemaName);
    if (!located.ok) {
      return {
        ok: false,
        failure: {
          command,
          reason: `could not locate schema ${schemaName}: ${located.failure.reason}`,
        },
      };
    }
    try {
      content = await readFile(path.join(located.value.path, "schema.yaml"));
      source = "package";
    } catch (error) {
      return {
        ok: false,
        failure: {
          command,
          reason: `could not read schema ${schemaName}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      };
    }
  }

  const topology = parseTopology(content, schemaName, source);
  if ("reason" in topology) {
    return { ok: false, failure: { command, reason: `schema ${schemaName}: ${topology.reason}` } };
  }
  return { ok: true, value: topology };
}
