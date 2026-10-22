import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { createTempDir } from "../../../test/fixtures";

const roots: string[] = [];
const runner = path.resolve(import.meta.dirname, "../../../test/run-isolated.ts");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

test.each(["unit", "integration", "all"])(
  "the %s suite selects its files with a clean launch environment",
  async (suite) => {
    const root = await createTempDir("acme-test-suite-");
    roots.push(root);
    const marker = path.join(root, "executed");
    for (const name of ["unit", "integration"]) {
      await fs.writeFile(
        path.join(root, `${name}.test.ts`),
        [
          name === "integration" ? "/** @test-requires sockets */" : "",
          'import fs from "node:fs";',
          'import os from "node:os";',
          'import { expect, test } from "bun:test";',
          `test("acme ${name}", () => {`,
          "  expect(process.env.MATE_ARTIFACT_PATH).toBeUndefined();",
          "  expect(process.env.MATE_REPO_ID).toBeUndefined();",
          ...(name === "unit" && suite === "unit"
            ? [
                '  expect(process.env.npm_config_offline).toBe("true");',
                "  expect(process.env.npm_config_cache).toStartWith(os.homedir());",
                "  expect(process.env.BUN_INSTALL_CACHE_DIR).toStartWith(os.homedir());",
              ]
            : []),
          `  fs.appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${name}\n`)});`,
          "});",
          "",
        ].join("\n"),
      );
    }

    const child = Bun.spawn(
      [process.execPath, runner, ...(suite === "all" ? [] : [`--suite=${suite}`])],
      {
        cwd: root,
        env: { ...process.env, MATE_ARTIFACT_PATH: "/acme/companion", MATE_REPO_ID: "acme" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect({ exitCode, output: exitCode === 0 ? "ok" : stdout + stderr }).toEqual({
      exitCode: 0,
      output: "ok",
    });
    expect((await fs.readFile(marker, "utf8")).trim().split("\n").toSorted()).toEqual(
      suite === "all" ? ["integration", "unit"] : [suite],
    );
  },
);
