/**
 * Builds `mate-vscode.vsix`, the only file the npm package ships.
 * vsce refuses a scoped name, so the extension manifest is staged with `name: "mate"`.
 * The VSIX is byte-reproducible: release preparation embeds its digest in core.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const defaultAppDir = path.join(import.meta.dir, "..");

/** 1980-01-01 UTC, the earliest DOS zip date. */
const SOURCE_DATE_EPOCH = "315532800";

/** Packages an already staged extension directory into `output`, byte-reproducibly. */
export function packageStagedVsix(stage: string, output: string): void {
  normalizeModes(stage);
  const vsce = path.join(
    path.dirname(createRequire(import.meta.url).resolve("@vscode/vsce/package.json")),
    "vsce",
  );
  execFileSync("node", [vsce, "package", "--no-dependencies", "-o", output], {
    cwd: stage,
    stdio: "inherit",
    // vsce fixes mtimes and sorts entries only with SOURCE_DATE_EPOCH; yazl writes DOS times in local time.
    env: { ...process.env, SOURCE_DATE_EPOCH, TZ: "UTC" },
  });
}

/** yazl takes each entry's mode from `stat`, which differs by umask. */
function normalizeModes(dir: string): void {
  fs.chmodSync(dir, 0o755);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) normalizeModes(file);
    else fs.chmodSync(file, 0o644);
  }
}

/** Builds the extension and writes `mate-vscode.vsix` into the app directory; returns its path. */
export function packageVsix(appDir = defaultAppDir): string {
  const output = path.join(appDir, "mate-vscode.vsix");
  execFileSync("bun", ["run", "build"], { cwd: appDir, stdio: "inherit" });

  const manifest = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8"));
  for (const key of ["scripts", "devDependencies", "publishConfig"]) delete manifest[key];
  manifest.name = "mate";
  manifest.files = ["dist/", "media/", "LICENSE", "README.md"];

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "mate-vscode-"));
  try {
    fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.cpSync(path.join(appDir, "dist"), path.join(stage, "dist"), { recursive: true });
    fs.cpSync(path.join(appDir, "media"), path.join(stage, "media"), { recursive: true });
    fs.copyFileSync(path.join(appDir, "README.md"), path.join(stage, "README.md"));
    fs.copyFileSync(path.join(appDir, "..", "..", "LICENSE"), path.join(stage, "LICENSE"));
    packageStagedVsix(stage, output);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  return output;
}

if (import.meta.main) packageVsix();
