/**
 * A generic, actionable hint printed on install failure — never guesses at
 * the actual registry URL/host. Private registries stay a plain, standard
 * npm operation: a one-time `npm config set --global`, or (since the shared
 * plugin workspace is a real npm project) a project-local, gitignored
 * `.npmrc` dropped directly in it — either is picked up by `npm install`
 * with nothing Mate-injected.
 */
export function registryConfigHint(packageName: string): string {
  const scope = packageName.startsWith("@") ? packageName.split("/")[0] : undefined;
  return scope
    ? `If "${scope}" lives in a private registry, configure it once with:\n  npm config set "${scope}:registry" "<registry-url>" --global\n  npm config set "//<registry-host>/:_authToken" "<token>" --global`
    : `If this package lives in a private registry, configure it once via \`npm config set\` (see the npm docs for scoped registries).`;
}
