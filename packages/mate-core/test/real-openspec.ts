import { locateOpenSpec } from "../src/lib/openspec-cli";

/** The OpenSpec CLI Mate ships, which the integration suites run for real. */
export function findRealOpenSpec(): string | undefined {
  const location = locateOpenSpec();
  return "bin" in location ? location.bin : undefined;
}
