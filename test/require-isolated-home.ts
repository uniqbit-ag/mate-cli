/**
 * Test preload: refuses a run whose HOME is not the temporary one
 * `run-isolated.ts` created, so no test can write the developer's real Mate
 * state or reach the registry on its behalf.
 */
import os from "node:os";

import { REAL_HOME_ENV, TEST_HOME_ENV } from "./isolated-home";

if (process.env[REAL_HOME_ENV] !== "1" && process.env[TEST_HOME_ENV] !== os.homedir()) {
  throw new Error(
    `tests must run with an isolated HOME: use \`bun run test\` (arguments pass through, ` +
      `e.g. \`bun run test -- src/foo.test.ts\`), or set ${REAL_HOME_ENV}=1 to use the real one.`,
  );
}
