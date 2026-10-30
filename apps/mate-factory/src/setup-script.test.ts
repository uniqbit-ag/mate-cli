import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.join(import.meta.dir, "..", "scripts", "setup.sh");
const TOKEN = "reg-token-0123456789";

let root: string;
let home: string;
let companion: string;
let stub: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mate-setup-"));
  home = path.join(root, "home");
  companion = path.join(root, "acme");
  fs.mkdirSync(home);
  fs.mkdirSync(companion);
  stub = path.join(root, "mate-stub");
  /** Records what the restore would see: arguments, config file, mode, environment. */
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bash
{
  echo "args=$*"
  echo "cwd=$PWD"
  echo "artifact=$MATE_ARTIFACT_PATH"
  echo "mode=$(stat -c %a "$NPM_CONFIG_USERCONFIG" 2>/dev/null || stat -f %Lp "$NPM_CONFIG_USERCONFIG")"
  echo "config<<"
  cat "$NPM_CONFIG_USERCONFIG"
} >"$RECORD"
echo "failing with $MATE_PLUGIN_REGISTRY_TOKEN" >&2
exit "\${STUB_STATUS:-0}"
`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function run(status = 0) {
  const record = path.join(root, "record");
  const result = spawnSync("bash", [SCRIPT, companion], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      MATE_COMMAND: stub,
      RECORD: record,
      STUB_STATUS: String(status),
      MATE_PLUGIN_REGISTRY_SCOPE: "@acme",
      MATE_PLUGIN_REGISTRY_URL: "https://registry.acme.test/api/npm/",
      MATE_PLUGIN_REGISTRY_TOKEN: TOKEN,
    },
  });
  return { result, record: fs.existsSync(record) ? fs.readFileSync(record, "utf8") : "" };
}

describe("the image-owned plugin restore", () => {
  test("runs the frozen install in the companion with an owner-only scoped npm config", () => {
    const { result, record } = run();
    expect(result.status).toBe(0);
    expect(record).toContain("args=install --yes --frozen-plugins");
    expect(record).toMatch(new RegExp(`cwd=.*${path.basename(root)}/acme\n`));
    expect(record).toContain(`artifact=${companion}`);
    expect(record).toContain("mode=600");
    expect(record).toContain("@acme:registry=https://registry.acme.test/api/npm/");
    expect(record).toContain(
      "//registry.acme.test/api/npm/:_authToken=${MATE_PLUGIN_REGISTRY_TOKEN}",
    );
  });

  test("writes no expanded token, and removes the generated config on success", () => {
    const { record } = run();
    expect(record).not.toContain(TOKEN);
    expect(fs.readdirSync(home)).toEqual([]);
    expect(fs.readdirSync(companion)).toEqual([]);
  });

  test("removes the generated config on failure and propagates the status", () => {
    const { result } = run(3);
    expect(result.status).toBe(3);
    expect(fs.readdirSync(home)).toEqual([]);
    expect(fs.readdirSync(companion)).toEqual([]);
  });

  test("refuses to run without the registry inputs", () => {
    const result = spawnSync("bash", [SCRIPT, companion], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home, MATE_COMMAND: stub },
    });
    expect(result.status).not.toBe(0);
  });
});
