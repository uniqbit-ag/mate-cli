/**
 * Extract repository name from a git URL.
 * Handles SSH (git@host:user/repo.git), HTTPS (https://host/user/repo.git),
 * and URLs without .git suffix.
 */
export function extractRepoName(url: string): string | null {
  if (!url || !url.trim()) {
    return null;
  }

  let cleaned = url.trim();

  // Handle SSH URLs: git@github.com:user/repo.git
  if (cleaned.includes(":") && !cleaned.startsWith("http")) {
    const afterColon = cleaned.split(":")[1];
    if (!afterColon) return null;
    cleaned = afterColon;
  }

  // Remove protocol prefix for HTTPS URLs
  cleaned = cleaned.replace(/^https?:\/\//, "");

  // Remove host prefix
  const parts = cleaned.split("/");
  if (parts.length < 2) {
    return null;
  }

  // Get the last path segment (repo name)
  const lastPart = parts[parts.length - 1];
  if (!lastPart) {
    return null;
  }

  // Strip .git suffix
  return lastPart.replace(/\.git$/, "");
}
