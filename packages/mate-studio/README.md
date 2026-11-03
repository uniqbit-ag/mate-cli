# @uniqbit/mate-studio

Mate Studio's browser application: TanStack Start, React, TanStack Query and Zustand. Private; it
is never published on its own. `@uniqbit/mate-core` ships its build and `mate studio` serves it.

## How it runs

`mate studio` owns the listener (`Bun.serve`): host and token checks, the terminal WebSocket and
`/assets/*`. Every other request goes to this application's built handler, with core's services
as request context (`context.studio`, typed by `StudioServices` from `@uniqbit/mate-core/studio`).
Server functions read and change state only through those services.

Every view is rendered here. Core's `APP_VIEW_PATHS` (in `studio-app.ts`) moves addresses from before
the move (`/?view=…`) to each view's own path.

## Develop

```bash
bun run build --watch                               # in packages/mate-studio
bun ../../apps/mate-cli/src/cli.ts studio serve --port 4180   # or `mate studio` from a checkout
```

The server loads `packages/mate-studio/dist` when no packaged build exists, so a rebuild plus a
reload shows the change. `bun run test` builds, then runs the tests against the built handler.

## Where state lives

| State                                                                     | Owner                                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Server data and every call                                                | TanStack Query: `lib/queries.ts` keys, `useSuspenseQuery`, `useMutation` |
| Anything in the address (companion, role, open Outcome, vault path)       | Router search params                                                     |
| Global client state (filter, terminal sidebar, unsaved edits, appearance) | Zustand stores in `stores/`, read through selectors                      |
| Local UI                                                                  | `useState`                                                               |

A value lives in exactly one place. Server data is never copied into a store, and anything the
address names never goes into one.

## Conventions

- File names are kebab-case; `routes/__root.tsx` is TanStack's own name.
- Styles live in `src/styles/studio.css`; the colour tokens come from core's `studioPaletteCss()`,
  shared with hosted reports, and are inlined before it. No CSS framework.
- The terminal is `@wterm/dom`, loaded as its own chunk the first time a terminal is shown; core
  serves only its WASM core.
