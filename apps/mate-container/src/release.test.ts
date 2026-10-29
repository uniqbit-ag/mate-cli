import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { CONTAINER_ROOT, readImageInputs } from "./image-inputs";
import {
  IMAGE_LOCKS,
  withMateVersion,
  withPublishedPackageVersions,
  withReleaseVersions,
} from "./image-pins";

const WORKSPACE_ROOT = path.resolve(CONTAINER_ROOT, "..", "..");

describe("the release tag's inputs pin its own published version", () => {
  test("the Mate version is rewritten without losing the file's comments", () => {
    const source = fs.readFileSync(path.join(CONTAINER_ROOT, "image-inputs.yaml"), "utf8");
    const rewritten = withMateVersion(source, "9.9.9");

    expect(rewritten).toContain("\nmate:\n  version: 9.9.9\n");
    // `minimum_compatible` is a different thing and must not move with it.
    expect(rewritten).toContain(`minimum_compatible: ${readImageInputs().mate.minimum_compatible}`);
    expect(rewritten).toContain("# Release-owned image inputs");
    expect(rewritten.split("\n").length).toBe(source.split("\n").length);
  });

  test("only the Mate section's version is rewritten", () => {
    const rewritten = withMateVersion(
      fs.readFileSync(path.join(CONTAINER_ROOT, "image-inputs.yaml"), "utf8"),
      "9.9.9",
    );
    // OpenCode's version is independent of Mate's and stays where it was.
    expect(rewritten).toContain(`version: ${readImageInputs().opencode.version}`);
  });

  test("no image input, manifest, or lock pins the retired OpenCode plugin package", () => {
    const files = [
      "image-inputs.yaml",
      ...IMAGE_LOCKS.flatMap(({ manifest, lock }) => [manifest, lock]),
    ];
    for (const file of files) {
      expect(fs.readFileSync(path.join(CONTAINER_ROOT, file), "utf8")).not.toContain(
        "@uniqbit/mate-opencode-plugin",
      );
    }
  });

  test("every Mate package in a lock manifest follows the release", () => {
    const rewritten = withReleaseVersions(
      JSON.stringify({
        dependencies: {
          "@uniqbit/mate": "0.1.0",
          "@uniqbit/mate-core": "0.1.0",
          "@fission-ai/openspec": "1.13.1",
        },
      }),
      "9.9.9",
    );
    const parsed = JSON.parse(rewritten) as { dependencies: Record<string, string> };
    expect(parsed.dependencies["@uniqbit/mate"]).toBe("9.9.9");
    expect(parsed.dependencies["@uniqbit/mate-core"]).toBe("9.9.9");
    // A third-party tool has its own version and is not dragged along.
    expect(parsed.dependencies["@fission-ai/openspec"]).toBe("1.13.1");
  });

  test("updates unpublished package entries from local tarball metadata", () => {
    const rewritten = withPublishedPackageVersions(
      JSON.stringify(
        {
          packages: {
            "": { dependencies: { "@uniqbit/mate": "0.1.0" } },
            "node_modules/@uniqbit/mate": {
              version: "0.1.0",
              resolved: "https://registry.npmjs.org/@uniqbit/mate/-/mate-0.1.0.tgz",
              integrity: "sha512-old",
              dependencies: {
                "@uniqbit/mate-core": "0.1.0",
                yaml: "^2.9.0",
              },
            },
          },
        },
        null,
        2,
      ),
      "9.9.9",
      [
        {
          name: "@uniqbit/mate",
          version: "9.9.9",
          dependencies: { "@uniqbit/mate-core": "9.9.9", yaml: "^2.9.0" },
        },
      ],
      new Map([["@uniqbit/mate", "sha512-new"]]),
    );

    expect(rewritten).toContain('"@uniqbit/mate": "9.9.9"');
    expect(rewritten).toContain('"integrity": "sha512-new"');
    expect(rewritten).toContain('"@uniqbit/mate-core": "9.9.9"');
    expect(rewritten).toContain("mate-9.9.9.tgz");
  });

  test("both lock manifests are kept in step with the release", () => {
    for (const { manifest, lock } of IMAGE_LOCKS) {
      expect(fs.existsSync(path.join(CONTAINER_ROOT, manifest))).toBe(true);
      expect(fs.existsSync(path.join(CONTAINER_ROOT, lock))).toBe(true);
    }
  });
});

describe("the release runs the image-input sync", () => {
  for (const config of [".release-it.json", ".release-it.canary.json"]) {
    test(`${config} syncs the image inputs after the version bump`, () => {
      const parsed = JSON.parse(fs.readFileSync(path.join(WORKSPACE_ROOT, config), "utf8")) as {
        hooks?: { "after:bump"?: string[] };
      };
      const hooks = parsed.hooks?.["after:bump"] ?? [];
      expect(hooks.some((hook) => hook.includes("sync-image-inputs.ts"))).toBe(true);
      // The package versions have to be settled before the image inputs follow.
      expect(hooks.findIndex((hook) => hook.includes("sync-release-versions"))).toBeLessThan(
        hooks.findIndex((hook) => hook.includes("sync-image-inputs")),
      );
    });
  }
});

describe("publication asks for an image only after npm has succeeded", () => {
  const publish = fs.readFileSync(path.join(WORKSPACE_ROOT, "publish.sh"), "utf8");
  const release = fs.readFileSync(
    path.join(WORKSPACE_ROOT, ".github", "workflows", "release.yml"),
    "utf8",
  );
  const imageJob = release.slice(release.indexOf("\n  image:"));

  test("the dispatch runs in its own job after the publish job", () => {
    expect(publish).not.toContain("gh workflow run");
    expect(imageJob).toContain("needs: [verify, publish]");
    expect(imageJob).toContain("gh workflow run publish-image.yml");
  });

  test("a partial npm failure never reaches the dispatch", () => {
    // `set -e` fails the publish job on the first failed `npm publish`, and the
    // image job only runs after the publish job succeeded.
    expect(publish).toContain("set -euo pipefail");
    expect(imageJob).not.toContain("if: always()");
  });

  test("it passes the exact version, the channel, and the pushed release tag", () => {
    expect(imageJob).toContain('--field version="$RELEASE_TAG"');
    expect(imageJob).toContain('--field channel="$CHANNEL"');
    expect(imageJob).toContain('--field ref="$RELEASE_TAG"');
  });

  test("a failed request preserves npm success and prints the retry", () => {
    expect(imageJob).toContain("continue-on-error: true");
    expect(imageJob).toContain("npm publication succeeded");
    expect(imageJob).toContain("Retry it with:");
  });

  test("it does not wait for the image build", () => {
    expect(imageJob).not.toContain("gh run watch");
    expect(imageJob).toContain("The build runs on its own");
  });
});

describe("the image workflow", () => {
  const workflow = fs.readFileSync(
    path.join(WORKSPACE_ROOT, ".github", "workflows", "publish-image.yml"),
    "utf8",
  );

  test("is dispatched explicitly, not by a release page or a tag push", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("on:\n  release:");
    expect(workflow).not.toMatch(/^\s+push:\s*$/m);
  });

  test("takes the exact version, the channel, and the release tag", () => {
    for (const input of ["version:", "channel:", "ref:"]) {
      expect(workflow).toContain(input);
    }
  });

  test("refuses a tag that carries no image recipe before building", () => {
    expect(workflow).toContain("carries no image recipe");
    const validate = workflow.indexOf("carries no image recipe");
    const build = workflow.indexOf("docker/build-push-action");
    expect(validate).toBeLessThan(build);
  });

  test("uses the callable registry wait, and refuses a channel that does not match", () => {
    expect(workflow).toContain("wait-for-published-packages.mjs");
    expect(workflow).toContain("cannot be published as latest");
    expect(workflow).toContain("cannot be published as canary");
  });

  test("refuses a tag whose inputs pin a different version", () => {
    expect(workflow).toContain("but this dispatch asks for");
  });

  test("builds and verifies both supported architectures", () => {
    expect(workflow).toContain("linux/amd64");
    expect(workflow).toContain("linux/arm64");
    expect(workflow).toContain("verify-image.ts");
    // Verification precedes anything an operator could pull.
    expect(workflow.indexOf("verify-image.ts")).toBeLessThan(workflow.indexOf("imagetools create"));
  });

  test("scopes its registry permissions explicitly", () => {
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("packages: write");
  });

  test("preserves an already-published exact version and never moves a channel backwards", () => {
    expect(workflow).toContain("keeping its existing digest");
    expect(workflow).toContain("which is newer than");
  });

  test("keeps the two channels apart", () => {
    expect(workflow).toContain("options: [latest, canary]");
    expect(workflow).toContain("$image:${{ inputs.channel }}");
  });
});
