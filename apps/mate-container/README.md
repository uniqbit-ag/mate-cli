# Mate appliance container

This package holds the appliance image's recipe (`Dockerfile`), its pinned
inputs (`image-inputs.yaml`, `locks/`), and its entrypoint and startup
program. Operators should read the deployment page in the docs site and
`compose.example.yaml`. This README is for contributors who want to run the
appliance with the Mate on their current branch.

## Running the appliance locally

Use this to check a Studio, startup, or CLI change inside the appliance
before it is released.

The image it builds is local only. It is tagged `mate-appliance:local`,
labelled as a working-tree build, and never pushed. The published image is
built by the release workflow from a published Mate.

### What it does

```
working tree --pack--> two tarballs ----+
                                        v
release Dockerfile --> local-base --> local overlay --> container
                       (reused)       (every run)          |
                                                           v
your companion (read-only) --clone on first start--> companions volume
```

- **Base image:** `mate-appliance:local-base` is built from the unchanged
  release `Dockerfile` and this branch's `image-inputs.yaml`. It is rebuilt
  only when the recipe, the pins, a lock file, or a file the recipe copies
  changes.
- **Overlay:** your working tree is packed with `pack-local.sh` as
  `<version>-local.<timestamp>` and installed over the base by
  `local.Dockerfile`. This runs on every start and takes seconds.
- **Companion:** your companion is mounted read-only, and the container's
  own startup clones it into a Docker volume. The container never writes to
  your companion directory.
- **No secrets:** Studio is reachable only on `127.0.0.1`, Git
  synchronisation is off, and the generated files in
  `apps/mate-container/.local/` hold no credentials.

### Prerequisites

- Docker (with Compose) or Podman (with `podman compose`). The script uses
  Podman when both are installed. Set `MATE_CONTAINER_RUNTIME=docker` to use
  Docker instead.
- Bun, Node and npm on your machine, for packing the working tree.
- `bun install` run at the repository root.
- Network access for the first base build.
- A companion that is a Git checkout. The default is
  `~/.mate/companions/mate-cli-companion`.

### First run

From the repository root:

```bash
bun run appliance:local
```

1. The base image is built. The first build downloads and checks every pinned
   tool and takes several minutes. Later runs reuse it.
2. The working tree is packed and installed into `mate-appliance:local`.
3. `apps/mate-container/.local/compose.yaml` and `appliance.yaml` are written.
4. The container starts, clones the companion, prepares it, and starts Studio.
5. The script prints the address to open:

   ```
     Studio: http://localhost:4097/?token=…
   ```

Open that address in your browser. The token is new on every container start,
so use the address from the latest run.

To serve another companion or use another port:

```bash
bun run appliance:local -- --companion ~/path/to/companion --port 4100
```

### After a code change

Run `bun run appliance:local` again. The base is reused, your code is packed
again, and the container is recreated. The script prints the version it
started, for example `Mate 0.18.5-local.20261024143000`. Inside the container,
`mate --version` reports the same version:

```bash
docker exec mate-appliance-local mate --version
```

The companion clone is kept between runs, including anything you changed in
it from Studio.

### Signing an agent in

The script writes no credentials. Open Studio's terminal and start Claude Code
or OpenCode. Each one asks you to sign in on first use. The login is stored in
the container's `mate-home` volume, so it survives `appliance:local:down` and
later starts.

### Uncommitted companion work

The container clones your companion, so it only sees committed history. When
the companion has uncommitted changes, the script warns:

```
appliance:local: warning: … has N uncommitted change(s). The container clones committed history only …
```

Commit the changes you want to see. The clone is made only on the first start,
so run `bun run appliance:local:reset` and then `bun run appliance:local` to
pick up new commits.

### Stopping and resetting

| Command                         | What it does                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `bun run appliance:local:down`  | Stops the container. Keeps the companion clone and the agent logins.                                                     |
| `bun run appliance:local:reset` | Stops the container and deletes both volumes and `.local/`. The next start clones afresh, and the agents are signed out. |
| `bun run appliance:local:logs`  | Follows the container log. Stop following with Ctrl-C.                                                                   |

The images stay after a reset. Remove them with
`docker image rm mate-appliance:local mate-appliance:local-base`.

### When something goes wrong

**`no container runtime found; install Docker or Podman.`**
Neither `docker` nor `podman` is on your `PATH`. Install one, or start Docker
Desktop.

**Startup fails with `Preparing the machine-local dependencies … failed`.**
The base image no longer matches the dependency pins your working tree
expects. The base is rebuilt automatically when a file in `locks/` changes,
but not when a pin changes somewhere else. Rebuild it:

```bash
bun run appliance:local -- --rebuild-base
```

**`port is already allocated` or `address already in use`.**
Something else is using port 4097, often a published appliance. Stop it, or
choose another port with `--port 4100`.

**`The checkout at /companions/<name> came from …`.**
The companions volume holds a clone of another companion. Run
`bun run appliance:local:reset`.

**Git reports `dubious ownership` while cloning.**
Some runtimes mount the companion with a different owner than the container
user. Add these three entries to the `environment` section of
`.local/compose.yaml`. Then start the container with
`docker compose -f apps/mate-container/.local/compose.yaml up -d`. Do not use
`appliance:local` for this start: it regenerates the file and drops your edit.

```yaml
GIT_CONFIG_COUNT: "1"
GIT_CONFIG_KEY_0: safe.directory
GIT_CONFIG_VALUE_0: /seed/<companion name>
```

**Studio does not print its address within 120 seconds.**
The script prints the last log lines and exits with an error. Read them, or
follow the full log with `bun run appliance:local:logs`.
