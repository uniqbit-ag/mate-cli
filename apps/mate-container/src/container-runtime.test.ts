import { describe, expect, test } from "bun:test";

import { CONTAINER_RUNTIME_ENV, findContainerRuntime } from "./container-runtime";

describe("which container runtime is used", () => {
  test("a named runtime wins over the one found first", () => {
    expect(findContainerRuntime({ [CONTAINER_RUNTIME_ENV]: "docker" })).toBe("docker");
  });

  test("an empty name falls back to discovery", () => {
    const discovered = findContainerRuntime({});
    expect(findContainerRuntime({ [CONTAINER_RUNTIME_ENV]: " " })).toBe(discovered);
  });
});
