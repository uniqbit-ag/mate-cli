/**
 * Docs consistency check: the first-change guide is authored, but its Delivery Path tables
 * must match the stage contract (stage order and skill IDs) for each schema Mate ships, and
 * those schemas' artifact sets must match the contract's. A schema or skill change fails
 * this check until the guide is updated.
 */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  deliveryPath,
  SCHEMA_ARTIFACTS,
} from "../../../packages/mate-core/src/lib/delivery/stages.ts";

const root = join(import.meta.dir, "..");
const guideFile = join(root, "content", "docs", "scenarios", "first-change.mdx");
const schemasDir = join(
  root,
  "..",
  "..",
  "packages",
  "mate-core",
  "src",
  "templates",
  "capabilities",
  "openspec-cap",
);

interface GuideRow {
  label: string;
  skill: string | null;
}

/** Rows of the first table after `{/* delivery-path:<schema> *\/}`. */
function guideTable(source: string, schema: string): GuideRow[] {
  const marker = `{/* delivery-path:${schema} */}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`no ${marker} table in ${relative(root, guideFile)}`);
  const lines = source.slice(start + marker.length).split("\n");
  const first = lines.findIndex((line) => line.startsWith("|"));
  const rows: GuideRow[] = [];
  for (const line of lines.slice(first + 2)) {
    if (!line.startsWith("|")) break;
    const [, , stage = "", driver = ""] = line.split("|").map((cell) => cell.trim());
    const skill = /^`([^`]+)`$/.exec(driver)?.[1] ?? null;
    rows.push({ label: stage.replace(/\s*\(optional\)$/, ""), skill });
  }
  return rows;
}

function schemaArtifactIds(schema: string): string[] {
  const parsed = Bun.YAML.parse(readFileSync(join(schemasDir, schema, "schema.yaml"), "utf8")) as {
    artifacts?: { id?: string }[];
  };
  return (parsed.artifacts ?? []).flatMap((artifact) => (artifact.id ? [artifact.id] : []));
}

const guide = readFileSync(guideFile, "utf8");
const problems: string[] = [];

for (const [schema, contractArtifacts] of Object.entries(SCHEMA_ARTIFACTS)) {
  const shipped = schemaArtifactIds(schema);
  if (shipped.join(",") !== contractArtifacts.join(",")) {
    problems.push(
      `${schema}: schema.yaml declares [${shipped.join(", ")}] but the stage contract expects [${contractArtifacts.join(", ")}]`,
    );
  }
  const expected = deliveryPath(shipped).stages.map((stage) => ({
    label: stage.label,
    skill: stage.skill,
  }));
  const actual = guideTable(guide, schema);
  const render = (rows: GuideRow[]): string =>
    rows.map((row) => `${row.label} (${row.skill ?? "you"})`).join(" → ");
  if (render(actual) !== render(expected)) {
    problems.push(`${schema}:\n  guide:    ${render(actual)}\n  contract: ${render(expected)}`);
  }
}

if (problems.length > 0) {
  console.error(
    `check-delivery-guide: ${relative(root, guideFile)} is out of step with the Delivery Path\n${problems.join("\n")}`,
  );
  process.exit(1);
}
console.log(
  `check-delivery-guide: the first-change guide matches the stage contract for ${Object.keys(SCHEMA_ARTIFACTS).join(" and ")}`,
);
