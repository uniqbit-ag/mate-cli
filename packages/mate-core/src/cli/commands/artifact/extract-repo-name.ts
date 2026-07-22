/**
 * Extract repository name from a git URL.
 * Handles SSH (git@host:user/repo.git and ssh://git@host:port/user/repo.git),
 * HTTPS (https://host/user/repo.git),
 * and URLs without .git suffix.
 */
export function extractRepoName(url: string): string | null {
  if (!url || !url.trim()) {
    return null;
  }

  const cleaned = url.trim();
  let repositoryPath: string;

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(cleaned)) {
    try {
      repositoryPath = new URL(cleaned).pathname;
    } catch {
      return null;
    }
  } else if (/^[^/\s@]+@[^/\s:]+:.+/.test(cleaned)) {
    // Handle scp-style SSH URLs: git@github.com:user/repo.git
    repositoryPath = cleaned.slice(cleaned.indexOf(":") + 1);
  } else {
    repositoryPath = cleaned.replace(/^https?:\/\//i, "");
  }

  const lastPart = repositoryPath.split("/").filter(Boolean).at(-1);
  if (!lastPart) {
    return null;
  }

  // Strip .git suffix
  return lastPart.replace(/\.git$/, "");
}
