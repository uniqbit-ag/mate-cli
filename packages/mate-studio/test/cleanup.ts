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
  /**
   * cleanup() unmounts the render containers, but a portal can outlive them —
   * a Base UI sheet lands in document.body and keeps its exit-transition node
   * until a timer fires, so on a slow machine it is still there when the next
   * test's whole-document queries (page.container.ownerDocument) run, which
   * read the wrong sheet. Nothing outside the current test may survive it.
   */
  document.body.replaceChildren();
});
