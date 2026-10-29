/**
 * Bun preload for the CLI e2e suite: points mate-core's in-process seam at the
 * recording OpenSpec stub named by `MATE_E2E_OPENSPEC_STUB`. Imported by real
 * path; Bun resolves the workspace link to the same module instance Mate uses.
 */
import { openSpecCliDeps } from "../../../../packages/mate-core/src/lib/openspec-cli";

const stub = process.env.MATE_E2E_OPENSPEC_STUB;
if (stub) openSpecCliDeps.locate = () => ({ bin: stub });
