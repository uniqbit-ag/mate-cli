import { spawnSync } from "node:child_process";

import { isCiEnvironment } from "../src/lib/ci-env";

if (isCiEnvironment(process.env.CI)) {
  console.log("Skipping lefthook install because CI is enabled.");
  process.exit(0);
}

const result = spawnSync("lefthook", ["install"], {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
