import type { RunOpenSpec } from "../../openspec-cli";
import type { ArtifactType } from "./artifact-type";
import { openspecArtifactType } from "./openspec-type";

/**
 * The artifact types Mate knows. The only module besides each type's own that names a type;
 * submit, publication, discovery and sync receive a type or ask here.
 */

/** Every artifact type, the default first; OpenSpec is the only built-in one. */
export function artifactTypes(runner?: RunOpenSpec): ArtifactType[] {
  return [openspecArtifactType(runner)];
}

/** The type submit and publication use unless a caller passes one. */
export function defaultArtifactType(runner?: RunOpenSpec): ArtifactType {
  return artifactTypes(runner)[0]!;
}
