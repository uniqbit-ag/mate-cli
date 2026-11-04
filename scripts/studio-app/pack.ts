/**
 * Builds Studio's application and copies it into `@uniqbit/mate-core` as `studio-dist/`, the
 * only form it ships in (`@uniqbit/mate-studio` is never published). Runs as core's `prepack`.
 * Absolute source paths the build records are made relative, so the tarball is the same on
 * every machine and names no local directory.
 */
import { spawnSync } from "node:child_process";
import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const STUDIO = path.join(ROOT, "packages/mate-studio");
const TARGET = path.join(ROOT, "packages/mate-core/studio-dist");
const TEXT = /\.(js|mjs|css|json|map|html)$/;

async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? files(full) : [full];
    }),
  );
  return nested.flat();
}

// Always a production build: a development JSX transform records source paths, which a test
// runner's NODE_ENV would otherwise switch on.
const build = spawnSync("bun", ["run", "build"], {
  cwd: STUDIO,
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production" },
});
if (build.status !== 0) process.exit(build.status ?? 1);

await rm(TARGET, { recursive: true, force: true });
await cp(path.join(STUDIO, "dist"), TARGET, { recursive: true });

const leaks: string[] = [];
for (const file of await files(TARGET)) {
  if (!TEXT.test(file)) continue;
  const text = await readFile(file, "utf8");
  const relative = text.replaceAll(`${STUDIO}/`, "").replaceAll(STUDIO, ".");
  if (relative !== text) await writeFile(file, relative);
  if (relative.includes(ROOT)) leaks.push(path.relative(ROOT, file));
}
if (leaks.length > 0) {
  console.error(`studio-dist still names the checkout in: ${leaks.join(", ")}`);
  process.exit(1);
}
console.log(`packed Studio into ${path.relative(ROOT, TARGET)}`);
