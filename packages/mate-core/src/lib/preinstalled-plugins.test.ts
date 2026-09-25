import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  CONTEXT_MODE_PACKAGE_NAME,
  CONTEXT_MODE_VERSION,
  isContextModePackageReference,
} from "./context-mode-package";
import {
  OPENCODE_PLUGIN_PACKAGE_NAME,
  isMateOpenCodePluginReference,
} from "./opencode-plugin-package";
import {
  PREBUILT_BUNDLE_MARKER,
  PreinstalledPluginMismatchError,
  getLocalWorkspaceDir,
  getPreinstalledPluginDir,
  resolvePreinstalledPluginReference,
} from "./preinstalled-plugins";

const tempRoots: string[] = [];

async function makeCompanion(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "preinstalled-plugin-"));
  tempRoots.push(dir);
  return dir;
}

async function installCopy(
  companionPath: string,
  packageName: string,
  manifest: Record<string, unknown>,
): Promise<string> {
  const dir = getPreinstalledPluginDir(companionPath, packageName);
  await fs.mkdir(dir, { recursive: true });
  /** Only a workspace the distribution supplied is ever bound. */
  await fs.writeFile(
    path.join(getLocalWorkspaceDir(companionPath), PREBUILT_BUNDLE_MARKER),
    JSON.stringify({ fingerprint: "test" }),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: packageName, ...manifest }, null, 2)}\n`,
    "utf8",
  );
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("resolvePreinstalledPluginReference", () => {
  test("binds a matching installed copy to its installed files", async () => {
    const companionPath = await makeCompanion();
    const dir = await installCopy(companionPath, CONTEXT_MODE_PACKAGE_NAME, {
      version: CONTEXT_MODE_VERSION,
      engines: { node: ">=22.5.0" },
    });

    const reference = await resolvePreinstalledPluginReference(
      companionPath,
      CONTEXT_MODE_PACKAGE_NAME,
      CONTEXT_MODE_VERSION,
      "24.0.0",
    );

    expect(reference).toBe(dir);
    expect(path.isAbsolute(reference!)).toBe(true);
  });

  test("binds each supported capability plugin the same way", async () => {
    const companionPath = await makeCompanion();
    const dir = await installCopy(companionPath, OPENCODE_PLUGIN_PACKAGE_NAME, {
      version: "9.9.9",
    });

    const reference = await resolvePreinstalledPluginReference(
      companionPath,
      OPENCODE_PLUGIN_PACKAGE_NAME,
      "9.9.9",
    );

    expect(reference).toBe(dir);
  });

  test("with no installed copy supplied, nothing is bound", async () => {
    const companionPath = await makeCompanion();

    const reference = await resolvePreinstalledPluginReference(
      companionPath,
      CONTEXT_MODE_PACKAGE_NAME,
      CONTEXT_MODE_VERSION,
    );

    expect(reference).toBeNull();
  });

  test("a version mismatch is reported naming the package and both versions", async () => {
    const companionPath = await makeCompanion();
    await installCopy(companionPath, CONTEXT_MODE_PACKAGE_NAME, { version: "0.0.1" });

    const attempt = resolvePreinstalledPluginReference(
      companionPath,
      CONTEXT_MODE_PACKAGE_NAME,
      CONTEXT_MODE_VERSION,
    );

    await expect(attempt).rejects.toBeInstanceOf(PreinstalledPluginMismatchError);
    await expect(attempt).rejects.toThrow(CONTEXT_MODE_PACKAGE_NAME);
    await expect(attempt).rejects.toThrow(CONTEXT_MODE_VERSION);
    await expect(attempt).rejects.toThrow("0.0.1");
  });

  test("a runtime-incompatible copy is refused rather than bound", async () => {
    const companionPath = await makeCompanion();
    await installCopy(companionPath, CONTEXT_MODE_PACKAGE_NAME, {
      version: CONTEXT_MODE_VERSION,
      engines: { node: ">=99.0.0" },
    });

    const attempt = resolvePreinstalledPluginReference(
      companionPath,
      CONTEXT_MODE_PACKAGE_NAME,
      CONTEXT_MODE_VERSION,
      "24.0.0",
    );

    await expect(attempt).rejects.toThrow(">=99.0.0");
    await expect(attempt).rejects.toThrow("24.0.0");
  });

  test("with no enforceable runtime, `engines.node` does not block binding", async () => {
    const companionPath = await makeCompanion();
    const dir = await installCopy(companionPath, CONTEXT_MODE_PACKAGE_NAME, {
      version: CONTEXT_MODE_VERSION,
      engines: { node: ">=99.0.0" },
    });

    expect(
      await resolvePreinstalledPluginReference(
        companionPath,
        CONTEXT_MODE_PACKAGE_NAME,
        CONTEXT_MODE_VERSION,
        null,
      ),
    ).toBe(dir);
  });

  test("a version mismatch is still refused with no enforceable runtime", async () => {
    const companionPath = await makeCompanion();
    await installCopy(companionPath, CONTEXT_MODE_PACKAGE_NAME, { version: "0.0.1" });

    const attempt = resolvePreinstalledPluginReference(
      companionPath,
      CONTEXT_MODE_PACKAGE_NAME,
      CONTEXT_MODE_VERSION,
      null,
    );

    await expect(attempt).rejects.toThrow(CONTEXT_MODE_VERSION);
  });
});

describe("a bound reference stays recognisable as Mate-managed", () => {
  test("context-mode's predicate matches the published reference and an installed path", () => {
    expect(
      isContextModePackageReference(`${CONTEXT_MODE_PACKAGE_NAME}@${CONTEXT_MODE_VERSION}`),
    ).toBe(true);
    expect(
      isContextModePackageReference(
        `/srv/acme/.mate/plugins/.local/node_modules/${CONTEXT_MODE_PACKAGE_NAME}`,
      ),
    ).toBe(true);
    expect(isContextModePackageReference("/srv/acme/node_modules/other-plugin")).toBe(false);
  });

  test("the Mate plugin's predicate matches the published reference and an installed path", () => {
    expect(isMateOpenCodePluginReference(`${OPENCODE_PLUGIN_PACKAGE_NAME}@1.2.3`)).toBe(true);
    expect(
      isMateOpenCodePluginReference(
        `/srv/acme/.mate/plugins/.local/node_modules/${OPENCODE_PLUGIN_PACKAGE_NAME}`,
      ),
    ).toBe(true);
    expect(isMateOpenCodePluginReference("@acme/other-plugin@1.0.0")).toBe(false);
  });
});

describe("an ordinary setup-installed workspace is not a supplied one", () => {
  test("an installed copy without the bundle marker is not bound", async () => {
    const companionPath = await makeCompanion();
    const dir = getPreinstalledPluginDir(companionPath, CONTEXT_MODE_PACKAGE_NAME);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: CONTEXT_MODE_PACKAGE_NAME, version: CONTEXT_MODE_VERSION }),
      "utf8",
    );

    const reference = await resolvePreinstalledPluginReference(
      companionPath,
      CONTEXT_MODE_PACKAGE_NAME,
      CONTEXT_MODE_VERSION,
    );

    expect(reference).toBeNull();
  });
});
