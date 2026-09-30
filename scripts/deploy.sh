#!/usr/bin/env bash
# Build and swap in a new dashboard with no downtime.
#
# Builds go to whichever of .next-a / .next-b isn't live, so the running server
# never sees its files change underneath it (building in place made it answer
# "Could not find a production build" for the length of the build). Then
# .next-live points at the new build and pm2 reloads: in cluster mode the new
# server is listening before the old one stops.
# Always reloads: a build left unserved would make the next one overwrite the
# directory the live server is still reading. `npm run build` runs this too.
set -euo pipefail
cd "$(dirname "$0")/.."

exec 9>.deploy.lock
flock -n 9 || { echo "another deploy is running" >&2; exit 1; }

live=$(cat .next-live 2>/dev/null || echo .next)
target=.next-a
[ "$live" = .next-a ] && target=.next-b

id="$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD)"
git diff --quiet HEAD -- . 2>/dev/null || id="$id-dirty"

rm -rf "$target"
mkdir -p "$target"
# Keep the webpack cache warm across the swap.
[ -d "$live/cache" ] && cp -a "$live/cache" "$target/"

echo "building $id into $target (live: $live)"
DASH_DIST_DIR="$target" DASH_BUILD_ID="$id" npx next build

echo "$target" > .next-live
pm2 reload kpp-dashboard
echo "live: $target ($id)"
