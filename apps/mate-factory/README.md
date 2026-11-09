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
  `local.Dockerfile`. When Mate's dependencies are unchanged, only its own two
  packages are replaced; otherwise the tool graph is reinstalled. This runs on
  every start and takes seconds.
- **Workset image:** the base's Workset archive is left as it is. The overlay
  ships this working tree's Workset tools and harness bridge as a small
  `workset-overlay.tar.zst`. Factory startup imports the base Workset image
  once per base (`mate-workset-base:<base id>`) and commits the overlay on top
  as `mate-workset:<local version>`, one layer per run. Superseded images go at
  the next start unless a container still uses them.
- **Companion:** your companion is mounted read-only, and the container's
  own startup clones it into a Docker volume. The container never writes to
  your companion directory.
- **Skills:** at every start the local image replaces each Mate skill the
  clone already carries with this working tree's version, so runs use the
  skills you are changing. Only the clone changes; nothing is committed, and
  the release image never does this.
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

The script writes no credentials. Studio's own terminal and the factory's
Workset agents sign in separately:

- **Studio's terminal.** Start Claude Code or OpenCode there; each asks you to
  sign in on first use. The login is stored in the container's `mate-home`
  volume, so it survives `factory:local:down` and later starts.
- **Workset agents.** Open the Factory view and choose **Agents**. For a Claude
  subscription, run `claude setup-token` on your own machine and paste the
  token it prints; or paste an Anthropic API key. The factory broker keeps it in
  the `factory-state` volume, readable by root only, and the next agent start
  uses it.

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

| Command                       | What it does                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun run factory:local:down`  | Stops the container. Keeps the companion clone and the agent logins.                                                                             |
| `bun run factory:local:reset` | Stops the container and deletes its volumes and `.local/`. The next start clones afresh, and the agents are signed out, Workset agents included. |
| `bun run factory:local:logs`  | Follows the container log. Stop following with Ctrl-C.                                                                                           |

The images stay after a reset. Remove them with
`docker image rm mate-factory:local mate-factory:local-base`.

### Workset sessions and AFK runs

The factory needs Docker Desktop, OrbStack or a Linux host with kernel 5.19 or
newer. It starts as root and privileged, with three more volumes
(`factory-docker`, `factory-sysbox`, `factory-state`). Its root supervisor
starts Sysbox, the inner Docker daemon and the factory broker, then Studio as
`mate`.

A Workset agent credential set in your shell (`CLAUDE_CODE_OAUTH_TOKEN` or
`ANTHROPIC_API_KEY`) is passed through as a fallback; it reaches the broker
only, and one set in the Agents panel takes precedence. Set
`MATE_FACTORY_REPOSITORIES` in your shell (for example
`https://github.com/acme/web.git`) to offer a repository on the Factory board.
`MATE_FACTORY_GIT_NAME` and `MATE_FACTORY_GIT_EMAIL` pass through too; without
them, the factory commits as `Mate factory <factory@mate.invalid>`.

`MATE_FACTORY_PARALLEL_RUNS`, `MATE_FACTORY_PARALLEL_BUILDS`,
`MATE_FACTORY_IDLE_MINUTES`, `MATE_FACTORY_WORKSET_MEMORY`,
`MATE_FACTORY_AGENT_MEMORY`, `MATE_FACTORY_WORKSET_PIDS` and
`MATE_FACTORY_WORKSET_CPUS` pass through as well, and so do the older
`MATE_FACTORY_MAX_RUNS` and the advanced `MATE_FACTORY_MAX_WORKSETS`. By default
two AFK runs work at once, both of which may build, and at most three Workset
containers run (the parallel runs plus one, kept free for a session). A build
or a session gets 4 GB with swap, an agent stage 1536 MB, each with 1024
processes, and one idle for 15 minutes is stopped. Size the factory at about
1 GB + (builds + 1) × 4 GB + (parallel runs − builds) × 1.5 GB. Each Workset's home lives on its own volume
in the inner daemon, so a container can be recreated without losing Claude
conversations. Docker Desktop's VM memory bounds the whole factory locally.

### Running the factory on Mate itself

`bun run factory:dogfood` starts the same local factory with this checkout as
the Working Repository. It serves a bare mirror of the checkout's local
branches from `.local/git/` with `git daemon` on 127.0.0.1:9418, and sets
`MATE_FACTORY_REPOSITORIES` to it. Worksets clone the mirror, never GitHub, and
the factory pushes its Delivery Branches back to it. Nothing reaches the real
remote.

- Worksets branch from your local `main`. Update it first.
- Each start fetches your local branches into the mirror, forced. A local branch
  overwrites a factory branch of the same name.
- `bun run factory:dogfood:pull` fetches the factory's branches into this
  checkout as `factory/*`.
- `bun run factory:dogfood:down` stops the container and `git daemon`.
  `bash apps/mate-factory/scripts/dogfood.sh reset` also removes the mirror
  and every branch the factory pushed.
- `MATE_DOGFOOD_GIT_PORT` changes the port. Other options, such as
  `--companion`, pass through to `local-up.ts`.

### Dependency locks

`locks/global-tools.package-lock.json` is checked on every pull request and
refreshed together with the appliance image's lock. See "Keeping the
dependency locks current" in `apps/mate-container/README.md`. Neither command
builds or publishes the factory image.

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
