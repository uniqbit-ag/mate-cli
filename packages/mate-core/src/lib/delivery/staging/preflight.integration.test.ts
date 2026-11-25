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
import { dropSubmitted, submitGroups } from "./submit";

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
    "a dependency of another group edited here since it was submitted is applied as submitted, as publication applies it",
    async () => {
      const fixture = await setup();
      const checkout = loginCheckout(fixture);
      checkout.product.commitOn("workset/acme-auth", "auth.txt", "auth\n");
      checkout.product.commitOn(LOGIN_BRANCH, "login-2.txt", "login\n");
      const api = proposeLocally(fixture, checkout.companion, "acme-login-api", {
        branch: "workset/acme-auth",
        deltas: { "acme-auth": requirement("ADDED", "Login", "The acme SHALL log in.") },
      });
      await submitGroups(checkout.companion, ["acme-login-api"], storage(fixture));
      const delta = path.join(api, "specs", "acme-auth", "spec.md");
      fs.writeFileSync(
        delta,
        fs.readFileSync(delta, "utf8").replace("Requirement: Login", "Requirement: Sign-in"),
      );
      proposeLocally(fixture, checkout.companion, "acme-login-ui", {
        branch: LOGIN_BRANCH,
        dependsOn: ["acme-login-api"],
        deltas: { "acme-auth": requirement("MODIFIED", "Login", "The acme SHALL log in fast.") },
      });

      const result = await submit(fixture, checkout, "acme-login-ui");

      expect(result).toMatchObject({ status: "submitted", pushed: true });
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

  test(
    "a stale delta pushed for the first time is submitted with a warning, as only its pending copy can be resolved",
    async () => {
      const fixture = await setup();
      const checkout = loginCheckout(fixture);
      const seed = git(checkout.companion, "rev-parse", "HEAD").trim();
      const teammate = fixture.clone("acme-teammate");
      const spec = path.join(teammate, "openspec", "specs", "widget", "spec.md");
      fs.writeFileSync(
        spec,
        fs.readFileSync(spec, "utf8").replace("The widget SHALL work.", "The widget SHALL hum."),
      );
      git(teammate, "commit", "-qam", "hum");
      git(teammate, "push", "-q", "origin", "HEAD");
      proposeLocally(fixture, checkout.companion, "acme-login-ui", {
        branch: LOGIN_BRANCH,
        specBase: seed,
        deltas: {
          widget:
            "## MODIFIED Requirements\n\n### Requirement: Widget renders\nThe widget SHALL glow.\n**Area:** `packages/web`\n\n#### Scenario: Works\n- **WHEN** used\n- **THEN** it works\n",
        },
      });

      const result = await submit(fixture, checkout, "acme-login-ui");

      expect(result).toMatchObject({ status: "submitted", pushed: true });
      const blocked = result.warnings.filter((warning) => warning.kind === "preflight-blocked");
      expect(blocked).toHaveLength(1);
      expect(blocked[0]!.message).toContain("mate artifact resolve");
    },
    TIMEOUT,
  );

  test(
    "a member dropped from another machine is not applied, as the push and publication leave it out",
    async () => {
      const fixture = await setup();
      const checkout = loginCheckout(fixture);
      proposeLocally(fixture, checkout.companion, "acme-login-old", {
        branch: LOGIN_BRANCH,
        deltas: { widget: requirement("MODIFIED", "Widget hums", "The widget SHALL hum.") },
      });
      await submitGroups(checkout.companion, ["acme-login-old"], storage(fixture));
      const other = fixture.clone("acme-other");
      expect(
        await dropSubmitted(other, "acme-login-old", {
          tmpRoot: fixture.root,
          stateHome: path.join(fixture.root, "home-other"),
        }),
      ).toMatchObject({ status: "dropped", pushed: true });
      proposeLocally(fixture, checkout.companion, "acme-login-api", {
        branch: LOGIN_BRANCH,
        deltas: { "acme-auth": requirement("ADDED", "Login", "The acme SHALL log in.") },
      });

      const result = await submit(fixture, checkout, "acme-login-api");

      expect(result).toMatchObject({ status: "submitted", pushed: true });
    },
    TIMEOUT,
  );
});
