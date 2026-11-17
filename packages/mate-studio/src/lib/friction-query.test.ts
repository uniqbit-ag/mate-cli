import { expect, test } from "bun:test";

import { validateStudioSearch } from "./search";
import { validateFrictionInput, validateRecordingInput } from "../server/friction";

const companion = "0123456789";

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
