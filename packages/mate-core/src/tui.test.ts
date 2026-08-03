import { describe, expect, test } from "bun:test";

import {
  SelectMenu,
  WizardFooter,
  WizardHeader,
  type SelectMenuItem,
} from "@uniqbit/mate-core/tui";

describe("Mate TUI components", () => {
  test("are exported through the core ./tui subpath", () => {
    const item: SelectMenuItem = { key: "example", label: "Example" };

    expect(SelectMenu).toBeFunction();
    expect(WizardFooter).toBeFunction();
    expect(WizardHeader).toBeFunction();
    expect(item.key).toBe("example");
  });
});
