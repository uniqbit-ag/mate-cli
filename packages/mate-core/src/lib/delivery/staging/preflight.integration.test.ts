import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { git } from "../../../../test/git-checkouts";
import {
  makeProductRepo,
  productEnvironment,
  type ProductRepo,
} from "../../../../test/product-repo";
import {
  canonicalSpec,
  makeStagingFixture,
  proposeLocally,
  REAL_OPENSPEC,
  requirement,
  type StagingFixture,
} from "../../../../test/staging-fixture";
import { submitChanges, type SubmitResult } from "../submit-change";
import { submitGroups } from "./submit";

const TIMEOUT = 90_000;
const LOGIN_BRANCH = "workset/acme-login";
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

function storage(fixture: StagingFixture) {
  return { tmpRoot: fixture.root, stateHome: path.join(fixture.root, "home") };
}

function loginCheckout(fixture: StagingFixture): { companion: string; product: ProductRepo } {
  const companion = fixture.clone("acme-companion");
  const product = makeProductRepo(fixture.root);
  product.commitOn(LOGIN_BRANCH, "login.txt", "login\n");
  return { companion, product };
}

async function submit(
  fixture: StagingFixture,
  checkout: { companion: string; product: ProductRepo },
  change: string,
): Promise<SubmitResult> {
  const outcome = await submitChanges(
    productEnvironment(checkout.companion, checkout.product),
    { changes: [change] },
    { ...storage(fixture), runOpenSpec: fixture.runOpenSpec },
  );
  if (!("results" in outcome)) throw new Error(`refused: ${outcome.refusal.reason}`);
  return outcome.results[0]!;
}

/** `acme-login-ui`, modifying the `acme-auth` requirement `acme-login-api` adds, submitted first. */
async function uiSubmittedFirst(
  fixture: StagingFixture,
  dependsOn?: string[],
): Promise<{ companion: string; product: ProductRepo }> {
  const checkout = loginCheckout(fixture);
  proposeLocally(fixture, checkout.companion, "acme-login-ui", {
    branch: LOGIN_BRANCH,
    ...(dependsOn ? { dependsOn } : {}),
    deltas: { "acme-auth": requirement("MODIFIED", "Login", "The acme SHALL log in fast.") },
  });
  await submitGroups(checkout.companion, ["acme-login-ui"], storage(fixture));
  proposeLocally(fixture, checkout.companion, "acme-login-api", {
    branch: LOGIN_BRANCH,
    deltas: { "acme-auth": requirement("ADDED", "Login", "The acme SHALL log in.") },
  });
  return checkout;
}

describe.skipIf(!REAL_OPENSPEC)("the publication pre-flight at submit", () => {
  test(
    "a modified requirement that drops a scenario fails submit, naming it, and pushes nothing",
    async () => {
      const fixture = await setup();
      const checkout = loginCheckout(fixture);
      proposeLocally(fixture, checkout.companion, "acme-login-api", {
        branch: LOGIN_BRANCH,
        deltas: { "acme-auth": requirement("ADDED", "Login", "The acme SHALL log in.") },
      });
      // `validate` cannot see the dropped scenario: the requirement exists only once the dependency is applied.
      proposeLocally(fixture, checkout.companion, "acme-login-ui", {
        branch: LOGIN_BRANCH,
        dependsOn: ["acme-login-api"],
        deltas: {
          "acme-auth":
            "## MODIFIED Requirements\n\n### Requirement: Login\nThe acme SHALL log in fast.\n**Area:** `packages/web`\n\n#### Scenario: Fast login\n- **WHEN** used\n- **THEN** it logs in fast\n",
        },
      });
      const refs = remoteRefs(fixture);

      const result = await submit(fixture, checkout, "acme-login-ui");

      expect(result).toMatchObject({ status: "failed", reason: "check-failed", pushed: false });
      expect(result.message).toContain("publication would refuse");
      expect(result.message).toContain("Login works");
      expect(remoteRefs(fixture)).toBe(refs);
    },
    TIMEOUT,
  );

  test(
    "a member applied before the change that adds what it modifies fails submit",
    async () => {
      const fixture = await setup();
      const checkout = await uiSubmittedFirst(fixture);
      const refs = remoteRefs(fixture);

      const result = await submit(fixture, checkout, "acme-login-api");

      expect(result).toMatchObject({ status: "failed", reason: "check-failed", pushed: false });
      expect(result.message).toContain("acme-login-ui");
      expect(result.message).toContain("acme-auth");
      expect(remoteRefs(fixture)).toBe(refs);
    },
    TIMEOUT,
  );

  test(
    "declaring the dependency passes, and the checkout's specs stay as they were",
    async () => {
      const fixture = await setup();
      const checkout = await uiSubmittedFirst(fixture, ["acme-login-api"]);
      const specs = path.join(checkout.companion, "openspec", "specs");
      const widget = fs.readFileSync(path.join(specs, "widget", "spec.md"), "utf8");

      const result = await submit(fixture, checkout, "acme-login-api");

      expect(result).toMatchObject({ status: "submitted", pushed: true });
      expect(fs.existsSync(path.join(specs, "acme-auth"))).toBe(false);
      expect(fs.readFileSync(path.join(specs, "widget", "spec.md"), "utf8")).toBe(widget);
      expect(git(checkout.companion, "status", "--porcelain", "--", "openspec/specs")).toBe("");
    },
    TIMEOUT,
  );

  test(
    "a dependency that exists nowhere skips the pre-flight with a warning and submits",
    async () => {
      const fixture = await setup();
      const checkout = loginCheckout(fixture);
      proposeLocally(fixture, checkout.companion, "acme-login-ui", {
        branch: LOGIN_BRANCH,
        dependsOn: ["acme-login-api"],
        deltas: { widget: requirement("ADDED", "Logout", "The widget SHALL log out.") },
      });

      const result = await submit(fixture, checkout, "acme-login-ui");

      expect(result).toMatchObject({ status: "submitted", pushed: true });
      const skipped = result.warnings.filter((warning) => warning.kind === "preflight-skipped");
      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.message).toContain("acme-login-api");
    },
    TIMEOUT,
  );
});
