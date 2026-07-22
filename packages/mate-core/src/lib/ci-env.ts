export function isCiEnvironment(ciValue: string | undefined): boolean {
  if (!ciValue) {
    return false;
  }

  const normalized = ciValue.trim().toLowerCase();

  if (normalized === "" || normalized === "0" || normalized === "false") {
    return false;
  }

  return true;
}
