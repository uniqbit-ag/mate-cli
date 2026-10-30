# Mate factory container

This package holds the factory image's recipe (`Dockerfile`), its pinned
inputs (`image-inputs.yaml`, `locks/`), and its entrypoint, supervisor and
startup program. The factory image is the appliance (`apps/mate-container`)
plus Sysbox, the inner Docker engine, the Workset image and the factory broker;
it is published as `mate-factory` beside `mate-appliance`, at the same versions.
Operators should read the factory page in the docs site and
`compose.example.yaml`. This README is for contributors who want to run the
factory with the Mate on their current branch.

## Running the factory locally

Use this to check a factory, Studio, startup, or CLI change inside the factory
image before it is released. It runs beside a local appliance: on port 4098,
under its own tags, volumes and `.local/` directory.

The image it builds is local only. It is tagged `mate-factory:local`,
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

- **Base image:** `mate-factory:local-base` is built from the unchanged
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
  `apps/mate-factory/.local/` hold no credentials.

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
bun run factory:local
```

1. The base image is built. The first build downloads and checks every pinned
   tool and takes several minutes. Later runs reuse it.
2. The working tree is packed and installed into `mate-factory:local`.
3. `apps/mate-factory/.local/compose.yaml` and `appliance.yaml` are written.
4. The container starts, clones the companion, prepares it, and starts Studio.
5. The script prints the address to open:

   ```
     Studio: http://localhost:4098/?token=…
   ```

Open that address in your browser. The token is new on every container start,
so use the address from the latest run.

To serve another companion or use another port:

```bash
bun run factory:local -- --companion ~/path/to/companion --port 4100
```

### After a code change

Run `bun run factory:local` again. The base is reused, your code is packed
again, and the container is recreated. The script prints the version it
started, for example `Mate 0.18.5-local.20261024143000`. Inside the container,
`mate --version` reports the same version:

```bash
docker exec mate-factory-local mate --version
```

The companion clone is kept between runs, including anything you changed in
it from Studio.

### Signing an agent in

The script writes no credentials. Open Studio's terminal and start Claude Code
or OpenCode. Each one asks you to sign in on first use. The login is stored in
the container's `mate-home` volume, so it survives `factory:local:down` and
later starts.

### Uncommitted companion work

The container clones your companion, so it only sees committed history. When
the companion has uncommitted changes, the script warns:

```
factory:local: warning: … has N uncommitted change(s). The container clones committed history only …
```

Commit the changes you want to see. The clone is made only on the first start,
so run `bun run factory:local:reset` and then `bun run factory:local` to
pick up new commits.

### Stopping and resetting

| Command                       | What it does                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `bun run factory:local:down`  | Stops the container. Keeps the companion clone and the agent logins.                                                    |
| `bun run factory:local:reset` | Stops the container and deletes its volumes and `.local/`. The next start clones afresh, and the agents are signed out. |
| `bun run factory:local:logs`  | Follows the container log. Stop following with Ctrl-C.                                                                  |

The images stay after a reset. Remove them with
`docker image rm mate-factory:local mate-factory:local-base`.

### Workset sessions and AFK runs

The factory needs Docker Desktop, OrbStack or a Linux host with kernel 5.19 or
newer. It starts as root and privileged, with three more volumes
(`factory-docker`, `factory-sysbox`, `factory-state`). Its root supervisor
starts Sysbox, the inner Docker daemon and the factory broker, then Studio as
`mate`.

A Workset agent credential is passed through from your shell
(`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`), else from the file
`mate factory setup` stores; it reaches the broker only. Set
`MATE_FACTORY_REPOSITORIES` in your shell (for example
`https://github.com/acme/web.git`) to offer a repository on the Factory board.
`MATE_FACTORY_GIT_NAME` and `MATE_FACTORY_GIT_EMAIL` pass through too; without
them, the factory commits as `Mate factory <factory@mate.invalid>`.

### When something goes wrong

**`no container runtime found; install Docker or Podman.`**
Neither `docker` nor `podman` is on your `PATH`. Install one, or start Docker
Desktop.

**Startup fails with `Preparing the machine-local dependencies … failed`.**
The base image no longer matches the dependency pins your working tree
expects. The base is rebuilt automatically when a file in `locks/` changes,
but not when a pin changes somewhere else. Rebuild it:

```bash
bun run factory:local -- --rebuild-base
```

**`port is already allocated` or `address already in use`.**
Something else is using port 4098. Stop it, or
choose another port with `--port 4100`.

**`The checkout at /companions/<name> came from …`.**
The companions volume holds a clone of another companion. Run
`bun run factory:local:reset`.

**Git reports `dubious ownership` while cloning.**
Some runtimes mount the companion with a different owner than the container
user. Add these three entries to the `environment` section of
`.local/compose.yaml`. Then start the container with
`docker compose -f apps/mate-factory/.local/compose.yaml up -d`. Do not use
`factory:local` for this start: it regenerates the file and drops your edit.

```yaml
GIT_CONFIG_COUNT: "1"
GIT_CONFIG_KEY_0: safe.directory
GIT_CONFIG_VALUE_0: /seed/<companion name>
```

**Studio does not print its address within 120 seconds.**
The script prints the last log lines and exits with an error. Read them, or
follow the full log with `bun run factory:local:logs`.
