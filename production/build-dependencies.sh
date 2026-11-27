#!/bin/sh
set -eu

pins="$PWD/production/dependencies.json"
pin() { node -p "require(process.argv[1]).$1" "$pins"; }
[ "$(node -p 'process.versions.node')" = "$(pin node)" ]
root="$PWD/vendor"
mkdir -p "$root/siteone"
git init -q "$root/niubigeo"
commit="$(pin niubigeo)"
git -C "$root/niubigeo" fetch --depth=1 https://github.com/Albert-Weasker/niubigeo.git "$commit"
git -C "$root/niubigeo" checkout -q --detach FETCH_HEAD
[ "$(git -C "$root/niubigeo" rev-parse HEAD)" = "$commit" ]
(
  cd "$root/niubigeo"
  npm ci --no-audit --no-fund
  npm run build
  npm prune --omit=dev --no-audit --no-fund
  rm -rf .git
)
archive="$(mktemp)"
trap 'rm -f "$archive"' EXIT
asset="$(pin siteone.linuxX64AssetId)"
curl -fLSs --retry 3 --connect-timeout 15 --max-time 240 \
  -H 'Accept: application/octet-stream' \
  "https://api.github.com/repos/janreges/siteone-crawler/releases/assets/$asset?download=1" -o "$archive"
printf '%s  %s\n' "$(pin siteone.linuxX64Sha256)" "$archive" | sha256sum -c -
tar -xzf "$archive" -C "$root/siteone"
binary="$(find "$root/siteone" -type f -name siteone-crawler -print -quit)"
[ -n "$binary" ] && [ -x "$binary" ]
ln -s "$binary" "$root/siteone-crawler"
