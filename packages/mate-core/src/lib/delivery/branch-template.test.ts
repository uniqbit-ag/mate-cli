import { describe, expect, test } from "bun:test";

import {
  applyBranchTemplate,
  branchTemplatePrefix,
  DEFAULT_BRANCH_TEMPLATE,
  matchBranchTemplate,
  parseBranchTemplate,
} from "./branch-template";

describe("applyBranchTemplate", () => {
  test.each([
    [DEFAULT_BRANCH_TEMPLATE, "workset/acme-fix", "workset/ABC-123-acme-fix"],
    ["feature/{ticket}-{workset}", "feature/acme-fix", "feature/ABC-123-acme-fix"],
    ["feature/{ticket}/{workset}", "feature/acme-fix", "feature/ABC-123/acme-fix"],
    ["feature/{workset}", "feature/acme-fix", "feature/acme-fix"],
    ["feature/{workset}_{ticket}", "feature/acme-fix", "feature/acme-fix_ABC-123"],
    ["feature/{ticket}{workset}", "feature/acme-fix", "feature/ABC-123acme-fix"],
  ])("%s without and with a ticket", (template, plain, ticketed) => {
    expect(applyBranchTemplate(template, "acme-fix")).toBe(plain);
    expect(applyBranchTemplate(template, "acme-fix", null)).toBe(plain);
    expect(applyBranchTemplate(template, "acme-fix", "ABC-123")).toBe(ticketed);
  });
});

describe("parseBranchTemplate", () => {
  test("absent means the default", () => {
    expect(parseBranchTemplate(undefined)).toEqual({
      template: DEFAULT_BRANCH_TEMPLATE,
      diagnostic: null,
    });
  });

  test("a valid template is kept", () => {
    expect(parseBranchTemplate("feature/{ticket}-{workset}")).toEqual({
      template: "feature/{ticket}-{workset}",
      diagnostic: null,
    });
  });

  test.each([
    ["feature/{ticket}", "{workset} must appear exactly once"],
    ["feature/{workset}-{workset}", "{workset} must appear exactly once"],
    ["{workset}", "a fixed prefix ending in /"],
    ["feature-{workset}", "a fixed prefix ending in /"],
    ["feature/{user}-{workset}", "unknown placeholder {user}"],
    ["feature/{ticket}-{ticket}-{workset}", "{ticket} may appear at most once"],
    ["feature/{workset}}", "a brace is not part of a placeholder"],
    ["feature/a..b/{workset}", "valid Git branch name"],
    ["feature/{workset}.lock", "valid Git branch name"],
    ["feature/x y/{workset}", "valid Git branch name"],
    [42, "not a string"],
  ])("%p falls back to the default", (value, rule) => {
    const setting = parseBranchTemplate(value);
    expect(setting.template).toBe(DEFAULT_BRANCH_TEMPLATE);
    expect(setting.diagnostic).toContain(rule);
  });
});

describe("branchTemplatePrefix", () => {
  test("is the text before the first placeholder", () => {
    expect(branchTemplatePrefix(DEFAULT_BRANCH_TEMPLATE)).toBe("workset/");
    expect(branchTemplatePrefix("team/feature/{workset}")).toBe("team/feature/");
  });
});

describe("matchBranchTemplate", () => {
  test("the default template, with and without a ticket", () => {
    expect(matchBranchTemplate(DEFAULT_BRANCH_TEMPLATE, "workset/acme-fix", "acme-fix")).toEqual({
      ticket: null,
    });
    expect(
      matchBranchTemplate(DEFAULT_BRANCH_TEMPLATE, "workset/ABC-123-acme-fix", "acme-fix"),
    ).toEqual({ ticket: "ABC-123" });
  });

  test("a lowercase ticket still matches", () => {
    expect(
      matchBranchTemplate(DEFAULT_BRANCH_TEMPLATE, "workset/abc-123-acme-fix", "acme-fix"),
    ).toEqual({ ticket: "abc-123" });
  });

  test("after {workset}, an all-lowercase key is another Workset's id, not a ticket", () => {
    // `feature/fix-login-2` is Workset fix-login-2's branch, not fix's with ticket login-2.
    const template = "feature/{workset}-{ticket}";
    expect(matchBranchTemplate(template, "feature/fix-login-2", "fix")).toBe(null);
    expect(matchBranchTemplate(template, "feature/fix-ABC-2", "fix")).toEqual({ ticket: "ABC-2" });
  });

  test("a team template with the ticket in its own segment", () => {
    const template = "feature/{ticket}/{workset}";
    expect(matchBranchTemplate(template, "feature/ABC-123/acme-fix", "acme-fix")).toEqual({
      ticket: "ABC-123",
    });
    expect(matchBranchTemplate(template, "feature/acme-fix", "acme-fix")).toEqual({ ticket: null });
  });

  test("other branches do not match", () => {
    expect(matchBranchTemplate(DEFAULT_BRANCH_TEMPLATE, "workset/acme-fix-2", "acme-fix")).toBe(
      null,
    );
    expect(
      matchBranchTemplate(DEFAULT_BRANCH_TEMPLATE, "workset/abc123-acme-fix", "acme-fix"),
    ).toBe(null);
    expect(matchBranchTemplate("feature/{workset}", "feature/ABC-1-acme-fix", "acme-fix")).toBe(
      null,
    );
    expect(matchBranchTemplate("feature/{ticket}-{workset}", "workset/acme-fix", "acme-fix")).toBe(
      null,
    );
  });

  test("regex characters in the template are literal", () => {
    expect(matchBranchTemplate("a.b/{ticket}-{workset}", "axb/ABC-1-acme", "acme")).toBe(null);
  });
});
