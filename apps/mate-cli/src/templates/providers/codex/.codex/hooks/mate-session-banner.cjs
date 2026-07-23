const { stdout, env } = process;

if (env.MATE_REPO_PATH && env.MATE_ARTIFACT_PATH) {
  stdout.write(
    JSON.stringify({
      systemMessage: `mate v${env.MATE_VERSION || "unknown"}\n  repo:     ${env.MATE_REPO_PATH}\n  mate: ${env.MATE_ARTIFACT_PATH}`,
    }),
  );
}
