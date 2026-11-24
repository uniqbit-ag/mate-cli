import path from "node:path";

import type { CompanionGit } from "../../../runtime/companion-git";
import type { ChangeLayout } from "../../change-layout";
import type { DeltaFailure, ReplayOptions, ReplayResult } from "./replay";

/** The `Mate-Artifact` trailer value of record `id`: `<type>/<id>`. */
export function artifactTrailerValue(type: ArtifactType, id: string): string {
  return `${type.name}/${id}`;
}

/** Source folder of change `name` of `type` below `root`. */
export function sourceDir(root: string, type: ArtifactType, name: string): string {
  return path.join(root, ...type.source.split("/"), name);
}

/**
 * Directory of `type`'s archived records below `root`, or of record `id` when given; null for a
 * type that keeps no archive.
 */
export function recordDir(root: string, type: ArtifactType, id?: string): string | null {
  if (type.archiveRoot === undefined) return null;
  return path.join(root, ...type.archiveRoot.split("/"), ...(id === undefined ? [] : [id]));
}

/** A part of a change the stale check names: its capability and requirement. */
export type StalePart = Pick<DeltaFailure, "capability" | "requirement">;

/** A derived file that failed the type's validation, with what failed. */
export interface ValidationFailure {
  path: string;
  detail: string;
}

/**
 * What submit, publication, pending discovery and synchronization know about one kind of
 * artifact. Only its hooks read or write the type's own files.
 */
export interface ArtifactType extends ChangeLayout {
  /** Name in the `Mate-Artifact: <type>/<id>` trailer. */
  name: string;
  /** Directory holding one source folder per change, relative to the companion. */
  source: string;
  /**
   * Directory holding one folder per archived record, relative to the companion. A type without
   * one keeps no history: its published records are read from `Mate-Artifact` trailers.
   */
  archiveRoot?: string;
  /** File in a source folder or record holding its Delivery Record. */
  deliveryFile: string;
  /** True for a directory name below {@link archiveRoot} that is a record. */
  isRecordId: (id: string) => boolean;
  /** The change name record `id` was archived from, which `dependsOn` lists. */
  recordName: (id: string) => string;
  /** Why change `name` in the checkout `dir` cannot be submitted, or null; runs at submit. */
  check: (dir: string, name: string) => Promise<string | null>;
  /**
   * Archives change `name` in the checkout `dir` and writes its derived files; runs at
   * publication. The result names the record it became.
   */
  apply: (dir: string, name: string, options?: ReplayOptions) => Promise<ReplayResult>;
  /**
   * The first part the change at `sourcePath` in `ref` changes that changed between `base`, the
   * commit it was written against, and `current`; null when none did. Never merged: applying
   * the change would overwrite that edit. Parts in `skip` are passed over.
   */
  stale?: (
    git: CompanionGit,
    ref: string,
    sourcePath: string,
    base: string,
    current: string,
    skip?: readonly StalePart[],
  ) => Promise<DeltaFailure | null>;
  /**
   * Rewrites `part` in the change at `changeDir` to `text`, the version a person or agent chose
   * from {@link DeltaFailure.versions}. Returns why it could not, or null.
   */
  resolve?: (changeDir: string, part: StalePart, text: string) => Promise<string | null>;
  /**
   * The parts the change in the folder `changeDir` rewrites or removes. Pending discovery lists
   * them, so an agent sees who else is changing a part before it plans against it.
   */
  touches?: (changeDir: string) => Promise<StalePart[]>;
  /** The first of `files` (changed derived files, relative to `dir`) that is invalid. */
  validate?: (dir: string, files: readonly string[]) => Promise<ValidationFailure | null>;
  /**
   * The plan of the change at `changeDir`, which the Path Position infers stages from. Absent for
   * a type without one: its stages are only recorded. Whether it validates is the caller's.
   */
  plan?: (changeDir: string) => Promise<{ totalTasks: number; completedTasks: number }>;
  /** The files of the change at `changeDir` a review can name, in review order, relative to it. */
  reviews?: (changeDir: string) => Promise<ReviewFile[]>;
}

/** A file of a change a review names. */
export interface ReviewFile {
  id: string;
  /** Relative to the change folder; a trailing `/` names a folder. */
  file: string;
}
