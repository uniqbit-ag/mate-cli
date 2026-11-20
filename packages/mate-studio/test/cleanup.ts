/**
 * Test preload: unmounts what Testing Library rendered after every test in every file.
 *
 * Its automatic cleanup registers `afterEach` on import, which runs once per process: only the
 * first file to import it got cleanup, so a later file's whole-document queries saw an earlier
 * file's trees, depending on the order the file system lists the files in.
 */
import { afterEach } from "bun:test";

process.env.RTL_SKIP_AUTO_CLEANUP = "true";

afterEach(async () => {
  // Only once a test registered the DOM: importing React DOM before it would bind it to no DOM.
  if (typeof document === "undefined") return;
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});
