import path from "node:path";

import { expect, test } from "bun:test";

const packageRoot = path.resolve(import.meta.dir, "..");

test("a strict consumer project typechecks against @uniqbit/mate-core/plugin-api", async () => {
  const tsc = Bun.spawn(["bunx", "tsc", "--noEmit", "-p", "test/plugin-api-consumer"], {
    cwd: packageRoot,
    stdout: "pipe",
    stderr: "ignore",
  });
  // tsc prints its diagnostics to stdout; stderr carries only bunx's install noise.
  const diagnostics = await new Response(tsc.stdout).text();

  expect({ exitCode: await tsc.exited, diagnostics }).toEqual({ exitCode: 0, diagnostics: "" });
}, 120_000);
