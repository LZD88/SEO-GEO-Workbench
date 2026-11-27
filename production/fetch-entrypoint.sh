#!/bin/sh
set -eu

# Fail closed if the runtime cannot install its own outbound packet policy.
nft -f /app/production/fetch-network.nft
export FETCH_NETWORK_ISOLATED=1
exec setpriv --reuid node --regid node --init-groups --bounding-set=-all --no-new-privs node /app/production/fetch.mjs
