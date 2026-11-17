import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { git } from "../../../../test/git-checkouts";
import {
  canonicalSpec,
  makeStagingFixture,
  proposeLocally,
  REAL_OPENSPEC,
  requirement,
  type StagingFixture,
} from "../../../../test/staging-fixture";
import { projectChange } from "./project";
import { submitGroups } from "./submit";

const TIMEOUT = 90_000;
const fixtures: StagingFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

async function setup(): Promise<StagingFixture> {
  const fixture = await makeStagingFixture({ widget: canonicalSpec("widget", "Widget renders") });
  fixtures.push(fixture);
  return fixture;
}

const remoteRefs = (fixture: StagingFixture): string =>
  git(fixture.remote, "for-each-ref", "--format=%(refname) %(objectname)");

describe.skipIf(!REAL_OPENSPEC)("projectChange", () => {
  test(
    "shows the requirement an unpublished submitted dependency adds and leaves the checkout alone",
    async () => {
      const fixture = await setup();
      const mine = fixture.clone("acme-mine");
      proposeLocally(fixture, mine, "acme-login-api", {
        branch: "workset/acme-login",
        state: "submitted",
        deltas: { widget: requirement("ADDED", "Login", "The widget SHALL log in.") },
      });
      await submitGroups(mine, ["acme-login-api"], {
        tmpRoot: fixture.root,
        stateHome: path.join(fixture.root, "home"),
      });
      const theirs = fixture.clone("acme-theirs");
      proposeLocally(fixture, theirs, "acme-login-ui", {
        branch: "workset/acme-login",
        dependsOn: ["acme-login-api"],
        deltas: { widget: requirement("MODIFIED", "Login", "The widget SHALL log in fast.") },
      });
      const status = git(theirs, "status", "--porcelain");
      const head = git(theirs, "rev-parse", "HEAD");
      const refs = remoteRefs(fixture);

      const result = await projectChange(theirs, "acme-login-ui", {
        runOpenSpec: fixture.runOpenSpec,
        tmpRoot: fixture.root,
        outRoot: fixture.root,
      });

      expect(result).toMatchObject({
        status: "ok",
        chain: [{ name: "acme-login-api", source: "submitted" }],
      });
      const [spec] = result.files;
      expect(spec?.path).toBe("openspec/specs/widget/spec.md");
      expect(spec?.content).toContain("### Requirement: Login");
      expect(fs.readFileSync(spec!.file, "utf8")).toBe(spec!.content);
      expect(spec!.file.startsWith(result.dir!)).toBe(true);
      // Nothing committed or pushed; the checkout and its specs are untouched.
      expect(git(theirs, "status", "--porcelain")).toBe(status);
      expect(git(theirs, "rev-parse", "HEAD")).toBe(head);
      expect(
        fs.readFileSync(path.join(theirs, "openspec/specs/widget/spec.md"), "utf8"),
      ).not.toContain("Login");
      expect(remoteRefs(fixture)).toBe(refs);
    },
    TIMEOUT,
  );

  test(
    "a symbolic link a teammate pushed to the pending branch is refused, not read",
    async () => {
      const fixture = await setup();
      const mine = fixture.clone("acme-mine");
      proposeLocally(fixture, mine, "acme-login-api", {
        branch: "workset/acme-login",
        state: "submitted",
        deltas: { widget: requirement("ADDED", "Login", "The widget SHALL log in.") },
      });
      await submitGroups(mine, ["acme-login-api"], {
        tmpRoot: fixture.root,
        stateHome: path.join(fixture.root, "home"),
      });
      const secret = path.join(fixture.root, "acme-secret.md");
      fs.writeFileSync(secret, "## ADDED Requirements\n\n### Requirement: Leaked\nacme-secret\n");
      const intruder = fixture.clone("acme-intruder");
      git(intruder, "fetch", "-q", "origin", "mate/inbox");
      git(intruder, "switch", "-q", "-c", "pending", "FETCH_HEAD");
      const delta = path.join(intruder, "openspec/changes/acme-login-api/specs/widget/spec.md");
      fs.rmSync(delta);
      fs.symlinkSync(secret, delta);
      git(intruder, "add", "-A");
      git(intruder, "commit", "-q", "-m", "link");
      git(intruder, "push", "-q", "origin", "HEAD:mate/inbox");
      const theirs = fixture.clone("acme-theirs");
      proposeLocally(fixture, theirs, "acme-login-ui", {
        branch: "workset/acme-login",
        dependsOn: ["acme-login-api"],
        deltas: { widget: requirement("ADDED", "Logout", "The widget SHALL log out.") },
      });

      const result = await projectChange(theirs, "acme-login-ui", {
        runOpenSpec: fixture.runOpenSpec,
        tmpRoot: fixture.root,
        outRoot: fixture.root,
      });

      expect(result).toMatchObject({ status: "error", files: [] });
      expect(result.message).toContain(
        "symbolic link or submodule at openspec/changes/acme-login-api/specs/widget/spec.md",
      );
    },
    TIMEOUT,
  );

  test(
    "a dependency that no longer applies fails with publication's reason",
    async () => {
      const fixture = await setup();
      const mine = fixture.clone("acme-mine");
      proposeLocally(fixture, mine, "acme-login-api", {
        deltas: { widget: requirement("MODIFIED", "Widget flies", "The widget SHALL fly.") },
      });
      proposeLocally(fixture, mine, "acme-login-ui", {
        dependsOn: ["acme-login-api"],
        deltas: { widget: requirement("ADDED", "Widget lands", "The widget SHALL land.") },
      });

      const result = await projectChange(mine, "acme-login-ui", {
        runOpenSpec: fixture.runOpenSpec,
        tmpRoot: fixture.root,
        outRoot: fixture.root,
      });

      expect(result.status).toBe("conflict");
      expect(result.chain).toEqual([{ name: "acme-login-api", source: "local" }]);
      expect(result.message).toContain("acme-login-api");
      expect(result.message).toContain("Widget flies");
    },
    TIMEOUT,
  );

  test(
    "a change without unpublished dependencies projects nothing",
    async () => {
      const fixture = await setup();
      const mine = fixture.clone("acme-mine");
      proposeLocally(fixture, mine, "acme-login", {
        deltas: { widget: requirement("ADDED", "Login", "The widget SHALL log in.") },
      });

      const result = await projectChange(mine, "acme-login", { tmpRoot: fixture.root });

      expect(result).toMatchObject({ status: "ok", chain: [], files: [], dir: null });
    },
    TIMEOUT,
  );
});
