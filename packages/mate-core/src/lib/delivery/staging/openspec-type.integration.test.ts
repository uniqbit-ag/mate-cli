import { afterEach, describe, expect, test } from "bun:test";

import {
  canonicalSpec,
  makeStagingFixture,
  proposeLocally,
  REAL_OPENSPEC,
  requirement,
  type StagingFixture,
} from "../../../../test/staging-fixture";
import { openspecArtifactType } from "./openspec-type";

const TIMEOUT = 60_000;
const fixtures: StagingFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

describe.skipIf(!REAL_OPENSPEC)("the OpenSpec type's check", () => {
  test(
    "names the warning that failed it and leaves out informational lines",
    async () => {
      const fixture = await makeStagingFixture({
        widget: canonicalSpec("widget", "Widget renders"),
      });
      fixtures.push(fixture);
      const companion = fixture.clone("acme-companion");
      const overlong = `The widget SHALL glow ${"brightly ".repeat(60)}.`;
      proposeLocally(fixture, companion, "acme-login", {
        deltas: {
          widget:
            requirement("ADDED", "Widget glows", overlong) +
            // A MODIFIED target the spec lacks is only an INFO line under validate.
            requirement("MODIFIED", "Widget hums", "The widget SHALL hum."),
        },
      });

      const failure = await openspecArtifactType(fixture.runOpenSpec).check(
        companion,
        "acme-login",
      );

      expect(failure).toContain('[WARNING] widget/spec.md: ADDED "Widget glows"');
      expect(failure).not.toContain("INFO");
      expect(failure).not.toContain("Widget hums");
    },
    TIMEOUT,
  );
});
