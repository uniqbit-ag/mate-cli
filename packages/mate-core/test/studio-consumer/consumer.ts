// An external consumer of the schema exports, typechecked with the root tsconfig.json.
// Names exported before `mate-full` existed must keep compiling.
import {
  canonicalSchema,
  DEFAULT_SCHEMA,
  isMateSchema,
  SCHEMA_ARTIFACTS,
  SHIPPED_SCHEMAS,
  type MateSchema,
} from "@uniqbit/mate-core/studio";

const legacy: MateSchema = "mate-v1";
const full: MateSchema = "mate-full";
const minimal: MateSchema = "mate-minimal";
const legacyArtifacts: readonly string[] = SCHEMA_ARTIFACTS["mate-v1"];
const shipped: readonly MateSchema[] = SHIPPED_SCHEMAS;
const fallback: MateSchema = DEFAULT_SCHEMA;
const known: boolean = isMateSchema("acme-flow");
const current: string = canonicalSchema(legacy);

export const used = [full, minimal, legacyArtifacts, shipped, fallback, known, current];
