/** @jsxImportSource hono/jsx */

import { describe, expect, it } from "bun:test";

import { CompanionError } from "./error";

describe("CompanionError", () => {
  it("names the companion and the reason", () => {
    const markup = String(
      <CompanionError
        companionPath="/home/dev/.mate/companions/acme-companion"
        reason="openspec list --json: exited with 1"
      />,
    );
    expect(markup).toContain("/home/dev/.mate/companions/acme-companion");
    expect(markup).toContain("openspec list --json: exited with 1");
    expect(markup).toContain('class="panel error"');
  });

  it("renders a reason containing markup characters as text", () => {
    const markup = String(
      <CompanionError companionPath="/tmp/acme" reason="<script>alert(1)</script>" />,
    );
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
