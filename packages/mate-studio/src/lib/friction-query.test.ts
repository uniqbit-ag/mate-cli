import { expect, test } from "bun:test";
import type { Query } from "@tanstack/react-query";

import { frictionQuery, frictionRecordingQuery, isFrictionQuery } from "./friction-query";
import { validateStudioSearch } from "./search";
import { validateFrictionInput, validateRecordingInput } from "../server/friction";

const companion = "0123456789";

test("the machine's recording query is a friction query, beside every companion's", () => {
  const matches = (queryKey: readonly unknown[]) => isFrictionQuery({ queryKey } as Query);
  expect([...frictionRecordingQuery.queryKey]).toEqual(["machine", "friction", "recording"]);
  expect(matches(frictionRecordingQuery.queryKey)).toBe(true);
  expect(matches(frictionQuery(companion, 30).queryKey)).toBe(true);
  expect(matches([companion, "specs"])).toBe(false);
});

test("the friction period in the address is 7, 30 or 90 days, else absent", () => {
  expect(validateStudioSearch({ frictionDays: "90" })).toEqual({ frictionDays: 90 });
  expect(validateStudioSearch({ frictionDays: 7 })).toEqual({ frictionDays: 7 });
  for (const frictionDays of [45, "30x", "", null])
    expect(validateStudioSearch({ frictionDays })).toEqual({});
});

test("the read takes a registered digest and a period of 7, 30 or 90 days", () => {
  expect(validateFrictionInput({ companion, days: 90 })).toEqual({ companion, days: 90 });
  expect(() => validateFrictionInput({ companion, days: 45 as never })).toThrow();
  expect(() => validateFrictionInput({ companion: "/acme/companion", days: 30 })).toThrow();
});

test("the switch takes a boolean only", () => {
  expect(validateRecordingInput({ recording: false })).toEqual({ recording: false });
  for (const recording of ["true", 1, null])
    expect(() => validateRecordingInput({ recording: recording as never })).toThrow();
});
