import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { lcovToCobertura, parseLcov } from "../../../packages/mate-core/src/lib/lcov-to-cobertura";

const coverageDir = path.join(process.cwd(), "coverage");
const coverageLcovPath = path.join(coverageDir, "lcov.info");
const coberturaPath = path.join(coverageDir, "cobertura-coverage.xml");
const shouldGenerateJunit = process.argv.includes("--junit");

async function run(command: string[]) {
  const processResult = Bun.spawnSync({
    cmd: command,
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });

  if (processResult.exitCode !== 0) {
    process.exit(processResult.exitCode ?? 1);
  }
}

await rm(coverageDir, { force: true, recursive: true });
await mkdir(coverageDir, { recursive: true });

if (shouldGenerateJunit) {
  await run([
    process.execPath,
    "test",
    "--reporter=junit",
    "--reporter-outfile=coverage/junit.xml",
  ]);
}

await run([
  process.execPath,
  "test",
  "--coverage",
  "--coverage-reporter=text",
  "--coverage-reporter=lcov",
  "--coverage-dir=coverage",
]);

const lcov = await readFile(coverageLcovPath, "utf8");
const cobertura = lcovToCobertura(lcov, { projectRoot: process.cwd() });
await writeFile(coberturaPath, cobertura);

const coverageFiles = parseLcov(lcov, process.cwd());
const linesValid = coverageFiles.reduce((sum, file) => sum + file.lines.length, 0);
const linesCovered = coverageFiles.reduce(
  (sum, file) => sum + file.lines.filter((line) => line.hits > 0).length,
  0,
);
const lineCoverage = linesValid === 0 ? 100 : (linesCovered / linesValid) * 100;

console.log(
  `Coverage summary: ${lineCoverage.toFixed(2)}% lines covered (${linesCovered}/${linesValid})`,
);
