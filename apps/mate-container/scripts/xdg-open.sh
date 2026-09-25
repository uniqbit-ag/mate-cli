#!/usr/bin/env bash
# There is no browser in this container to open.
#
# `opencode web` opens its own URL on startup and has no flag to say otherwise;
# without an `xdg-open` on PATH it fails with ENOENT and takes the session down
# with it. The appliance serves that URL to whoever is holding the other end of
# the published port, so the right answer here is to accept the request, say
# where the thing is, and carry on.
printf 'mate-appliance: not opening %s — this container has no browser; reach it on the published port.\n' "${1:-a URL}" >&2
exit 0
