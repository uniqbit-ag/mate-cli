import { describe, expect, test } from "bun:test";

import { byFolderPath } from "./pending";

describe("byFolderPath", () => {
  test("orders changes one commit adds as Git lists their folders", () => {
    expect(["acme-login", "acme-login-ui"].toSorted(byFolderPath)).toEqual([
      "acme-login-ui",
      "acme-login",
    ]);
  });
});
