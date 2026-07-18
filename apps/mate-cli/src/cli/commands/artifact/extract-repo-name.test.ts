import { extractRepoName } from "./extract-repo-name";

describe("extractRepoName", () => {
  describe("SSH URLs", () => {
    test("extracts name from standard SSH URL", () => {
      expect(extractRepoName("git@github.com:user/my-companion.git")).toBe("my-companion");
    });

    test("extracts name from GitLab SSH URL", () => {
      expect(extractRepoName("git@gitlab.com:org/team/artifact-repo.git")).toBe("artifact-repo");
    });

    test("handles SSH URL without .git suffix", () => {
      expect(extractRepoName("git@github.com:user/companion")).toBe("companion");
    });
  });

  describe("HTTPS URLs", () => {
    test("extracts name from HTTPS URL", () => {
      expect(extractRepoName("https://github.com/user/companion.git")).toBe("companion");
    });

    test("extracts name from HTTPS URL with nested path", () => {
      expect(extractRepoName("https://gitlab.com/org/team/artifact-repo.git")).toBe(
        "artifact-repo",
      );
    });

    test("handles HTTPS URL without .git suffix", () => {
      expect(extractRepoName("https://github.com/user/companion")).toBe("companion");
    });

    test("handles HTTP URL", () => {
      expect(extractRepoName("http://github.com/user/companion.git")).toBe("companion");
    });
  });

  describe("Edge cases", () => {
    test("returns null for empty string", () => {
      expect(extractRepoName("")).toBeNull();
    });

    test("returns null for whitespace only", () => {
      expect(extractRepoName("   ")).toBeNull();
    });

    test("returns null for null input", () => {
      expect(extractRepoName(null as unknown as string)).toBeNull();
    });

    test("returns null for URL without path", () => {
      expect(extractRepoName("https://github.com")).toBeNull();
    });

    test("trims whitespace from URL", () => {
      expect(extractRepoName("  https://github.com/user/repo.git  ")).toBe("repo");
    });
  });
});
